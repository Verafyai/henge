/**
 * Verification pipeline (SPEC 7.3, 8, 9.2). A submitted result moves:
 *
 *   Submitted -> Verifying   schema and device signature valid
 *   Submitted -> Rejected    invalid schema or signature
 *   Verifying -> Pending     every method the manifest lists accepted it
 *   Verifying -> Rejected    any method rejected it
 *   Pending   -> Settled     the swarm's review window closed with no fraud found
 *   Pending   -> ClawedBack  fraud found while pending
 *
 * Every decision writes a signed `verification_records` row. Known answers, redundancy and the jury
 * adapter run here; machine checks (Lean, the Prompt Guard replay) run in the verifier worker and
 * arrive through `recordWorkerVerdict`. Nothing runs on a timer: the API advances results lazily,
 * like lease expiry.
 *
 * Acceptance awards impact (SPEC 9.1). Credits move only for a funded swarm with a pool reservation
 * for the lease (SPEC 8.2, 9.2); volunteer work can never create credits.
 */
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import type { ManifestV1 } from '@swarm-explorer/schema';
import { canonicalJson } from '@swarm-explorer/schema';
import {
  knownAnswersVerifier,
  MACHINE_CHECKERS,
  recordPayload,
  redundancyVerdicts,
  juryVerifier,
  signingKeyFromPkcs8,
  signRecord,
  splitSignature,
  verificationRecordMessage,
  verifySignature,
  type JuryAdapter,
  type RecordPayload,
  type SigningKey,
  type Verdict,
  type VerificationMethod,
} from '@swarm-explorer/verify';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { getDb, type Db } from './client';
import { rebalanceShares } from './coordinator';
import { LedgerError, MembershipError } from './errors';
import { acceptPending, clawbackCredits, releaseReservation, settleCredits, type Tx } from './ledger';
import { recordReputation } from './reputation';
import {
  impactEvents,
  installs,
  leases,
  memberships,
  nodes,
  outboxEvents,
  qualificationAttempts,
  qualifications,
  qualificationTasks,
  results,
  runRecords,
  swarmReleases,
  swarms,
  taskKnownAnswers,
  tasks,
  verificationRecords,
  verificationRules,
  verifierKeys,
  verifierNonces,
} from './schema';

export const INTAKE_VERSION = 'coordinator-intake-v1';
const err = (status: number, code: string, message: string, details?: Record<string, unknown>) => new MembershipError(status, code, message, details);

/* ----------------------------------------------------------------------------
 * Rules and keys
 * ------------------------------------------------------------------------- */

export type VerificationRule = { version: number; reviewWindowS: number | null; knownAnswerRate: number | null; redundancyCount: number | null; juryPanelSize: number | null };

/** The newest verification rule for a swarm. With none stored, nothing is configured. */
export async function currentVerificationRule(tx: Tx | Db, swarmId: string): Promise<VerificationRule> {
  const [r] = await tx.select().from(verificationRules).where(eq(verificationRules.swarmId, swarmId)).orderBy(desc(verificationRules.version)).limit(1);
  return r ?? { version: 0, reviewWindowS: null, knownAnswerRate: null, redundancyCount: null, juryPanelSize: null };
}

/** Stores a new rule version (dev tooling and tests; the admin surface is later). */
export async function setVerificationRule(o: { swarmSlug: string; reviewWindowS?: number | null; redundancyCount?: number | null; juryPanelSize?: number | null; knownAnswerRate?: number | null; notes: string }) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(swarms).where(eq(swarms.slug, o.swarmSlug)).limit(1);
    if (!s) throw err(404, 'not_found', 'No such swarm.');
    const cur = await currentVerificationRule(tx, s.id);
    const [row] = await tx
      .insert(verificationRules)
      .values({
        swarmId: s.id,
        version: cur.version + 1,
        reviewWindowS: o.reviewWindowS === undefined ? cur.reviewWindowS : o.reviewWindowS,
        redundancyCount: o.redundancyCount === undefined ? cur.redundancyCount : o.redundancyCount,
        juryPanelSize: o.juryPanelSize === undefined ? cur.juryPanelSize : o.juryPanelSize,
        knownAnswerRate: o.knownAnswerRate === undefined ? cur.knownAnswerRate : o.knownAnswerRate,
        notes: o.notes,
      })
      .returning();
    return row!;
  });
}

const g = globalThis as unknown as { __coordinatorVerifierKey?: SigningKey };

/**
 * The coordinator's record-signing key. `COORDINATOR_VERIFIER_KEY` (PKCS8 DER, base64url) in a
 * deployment; without it a per-process key is made, which is fine for development and tests because
 * its public half is registered in `verifier_keys` before it signs anything.
 */
export function coordinatorKey(): SigningKey {
  if (!g.__coordinatorVerifierKey) {
    const env = process.env['COORDINATOR_VERIFIER_KEY'];
    const pkcs8 = env ?? generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
    const probe = signingKeyFromPkcs8('probe', pkcs8);
    const keyId = `coordinator-${env ? '' : 'dev-'}${createHash('sha256').update(probe.publicKey).digest('hex').slice(0, 16)}`;
    g.__coordinatorVerifierKey = signingKeyFromPkcs8(keyId, pkcs8);
  }
  return g.__coordinatorVerifierKey;
}

async function registerKey(tx: Tx, key: { keyId: string; publicKey: string }, kind: 'coordinator' | 'worker', methods: string[]) {
  await tx.insert(verifierKeys).values({ keyId: key.keyId, publicKey: key.publicKey, kind, methods }).onConflictDoNothing();
}

/**
 * Registers verifier worker keys from `VERIFIER_WORKER_KEYS` (`keyId=spkiBase64url`, comma
 * separated). A key already registered keeps its stored public key and status.
 */
export async function registerWorkerKeysFromEnv(env = process.env['VERIFIER_WORKER_KEYS']) {
  if (!env) return 0;
  const db = await getDb();
  let n = 0;
  await db.transaction(async (tx) => {
    for (const part of env.split(',').map((p) => p.trim()).filter(Boolean)) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      await registerKey(tx, { keyId: part.slice(0, i), publicKey: part.slice(i + 1) }, 'worker', ['machine-check']);
      n++;
    }
  });
  return n;
}

export async function verifierKey(keyId: string) {
  const db = await getDb();
  const [k] = await db.select().from(verifierKeys).where(eq(verifierKeys.keyId, keyId)).limit(1);
  return k ?? null;
}

/** Accepts a verifier request nonce once per key. */
export async function useVerifierNonce(keyId: string, nonce: string, now = new Date(), windowMs = 10 * 60_000) {
  const db = await getDb();
  await db.delete(verifierNonces).where(and(eq(verifierNonces.keyId, keyId), lte(verifierNonces.seenAt, new Date(now.getTime() - windowMs))));
  const ins = await db.insert(verifierNonces).values({ keyId, nonce, seenAt: now }).onConflictDoNothing().returning({ n: verifierNonces.nonce });
  return ins.length > 0;
}

/* ----------------------------------------------------------------------------
 * Facts about a result
 * ------------------------------------------------------------------------- */

type Facts = {
  result: typeof results.$inferSelect;
  lease: typeof leases.$inferSelect;
  task: typeof tasks.$inferSelect;
  release: typeof swarmReleases.$inferSelect;
  swarm: typeof swarms.$inferSelect;
  manifest: ManifestV1;
};

async function facts(tx: Tx | Db, resultId: string): Promise<Facts | null> {
  const [r] = await tx
    .select({ result: results, lease: leases, task: tasks, release: swarmReleases, swarm: swarms })
    .from(results)
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .innerJoin(swarmReleases, eq(swarmReleases.id, tasks.releaseId))
    .innerJoin(swarms, eq(swarms.id, tasks.swarmId))
    .where(eq(results.id, resultId))
    .limit(1);
  return r ? { ...r, manifest: r.release.manifestJson as ManifestV1 } : null;
}

const methodsOf = (f: Facts) => f.manifest.verification as VerificationMethod[];

/** Re-checks the run record's device signature against the install that holds the lease (SPEC 7.3). */
async function runRecordSignatureOk(tx: Tx, f: Facts): Promise<boolean> {
  const [r] = await tx
    .select({ run: runRecords, key: installs.devicePublicKey })
    .from(runRecords)
    .innerJoin(leases, eq(leases.id, runRecords.leaseId))
    .innerJoin(nodes, eq(nodes.id, leases.nodeId))
    .innerJoin(installs, eq(installs.id, nodes.installId))
    .where(eq(runRecords.leaseId, f.lease.id))
    .limit(1);
  if (!r?.run.recordJson) return false;
  const { signature, ...rest } = r.run.recordJson as Record<string, unknown>;
  if (signature !== r.run.runRecordSignature || rest['output_sha256'] !== f.result.outputHash || rest['lease_id'] !== f.lease.id) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(r.key, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`swarm-explorer-run-record-v1\n${canonicalJson(rest)}`), key, Buffer.from(String(signature), 'base64url'));
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * Records and decisions
 * ------------------------------------------------------------------------- */

async function writeRecord(tx: Tx, f: Facts, method: VerificationMethod, v: Verdict, signed?: { keyId: string; signature: string }) {
  let signature: string;
  let keyId: string;
  if (signed) {
    signature = `${signed.keyId}:${signed.signature}`;
    keyId = signed.keyId;
  } else {
    const key = coordinatorKey();
    await registerKey(tx, key, 'coordinator', ['machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review']);
    signature = signRecord(key, recordPayload({ type: 'result', id: f.result.id }, method, f.result.outputHash, v));
    keyId = key.keyId;
  }
  const [row] = await tx
    .insert(verificationRecords)
    .values({
      resultId: f.result.id,
      leaseId: f.lease.id,
      releaseId: f.release.id,
      method,
      verifierVersion: v.verifierVersion,
      verifierKeyId: keyId,
      evidenceHashes: v.evidenceHashes,
      resultHash: f.result.outputHash,
      outcome: v.outcome,
      rationaleCode: v.rationaleCode,
      panelJson: v.panel ?? null,
      signature,
    })
    .onConflictDoNothing()
    .returning();
  await tx.insert(outboxEvents).values({ topic: v.outcome === 'accepted' ? 'verification.accepted' : 'verification.rejected', payload: { result_id: f.result.id, lease_id: f.lease.id, method } });
  return row ?? null;
}

async function reject(tx: Tx, f: Facts, now: Date) {
  const [moved] = await tx
    .update(leases)
    .set({ status: 'rejected', rejectedAt: now })
    .where(and(eq(leases.id, f.lease.id), inArray(leases.status, ['submitted', 'verifying'])))
    .returning({ id: leases.id });
  if (!moved) return;
  if (f.swarm.fundedMode === 'funded') await releaseReservation(tx, { leaseId: f.lease.id, swarmId: f.swarm.id });
  await recordReputation(tx, { accountId: f.lease.accountId, nodeId: f.lease.nodeId, swarmId: f.swarm.id, type: 'result_rejected', evidenceRef: `result:${f.result.id}` });
}

async function accept(tx: Tx, f: Facts, now: Date) {
  const [moved] = await tx.update(leases).set({ status: 'pending', pendingAt: now }).where(and(eq(leases.id, f.lease.id), eq(leases.status, 'verifying'))).returning({ id: leases.id });
  if (!moved) return;
  const rule = await currentVerificationRule(tx, f.swarm.id);
  if (rule.reviewWindowS !== null) await tx.update(verificationRecords).set({ pendingWindowEndsAt: new Date(now.getTime() + rule.reviewWindowS * 1000) }).where(eq(verificationRecords.resultId, f.result.id));
  // Impact for every accepted task, funded or volunteer (SPEC 9.1). Nonspendable.
  await tx.insert(impactEvents).values({ accountId: f.lease.accountId, nodeId: f.lease.nodeId, swarmId: f.swarm.id, category: f.swarm.category, units: f.manifest.impact.category_weight, resultId: f.result.id, createdAt: now }).onConflictDoNothing();
  await tx.insert(outboxEvents).values({ topic: 'impact.awarded', payload: { result_id: f.result.id, units: f.manifest.impact.category_weight } });
  if (f.swarm.fundedMode === 'funded' && f.manifest.credits.funded && f.task.rewardCredits) {
    const [rec] = await tx.select({ id: verificationRecords.id }).from(verificationRecords).where(eq(verificationRecords.resultId, f.result.id)).orderBy(asc(verificationRecords.createdAt)).limit(1);
    try {
      await acceptPending(tx, { resultId: f.result.id, leaseId: f.lease.id, accountId: f.lease.accountId, swarmId: f.swarm.id, amount: f.task.rewardCredits, verificationRecordId: rec!.id });
      await tx.insert(outboxEvents).values({ topic: 'credits.pending', payload: { result_id: f.result.id, credits: f.task.rewardCredits } });
    } catch (e) {
      // No reservation, no credit (SPEC 8.2). The acceptance and its impact stand.
      if (!(e instanceof LedgerError)) throw e;
      await tx.insert(outboxEvents).values({ topic: 'credits.reservation_missing', payload: { result_id: f.result.id, code: e.code } });
    }
  }
  await recordReputation(tx, { accountId: f.lease.accountId, nodeId: f.lease.nodeId, swarmId: f.swarm.id, type: 'result_accepted', evidenceRef: `result:${f.result.id}` });
}

/** Rejected if any method rejected; Pending once every listed method accepted; otherwise waits. */
async function decide(tx: Tx, f: Facts, now: Date) {
  const recs = await tx.select().from(verificationRecords).where(eq(verificationRecords.resultId, f.result.id));
  if (recs.some((r) => r.outcome === 'rejected')) return reject(tx, f, now);
  if (methodsOf(f).every((m) => recs.some((r) => r.method === m && r.outcome === 'accepted'))) return accept(tx, f, now);
}

/* ----------------------------------------------------------------------------
 * Intake: Submitted to Verifying or Rejected
 * ------------------------------------------------------------------------- */

export type PipelineDeps = {
  /** Checks the output against the harness output schema when the coordinator holds the bundle. */
  schemaCheck?: (releaseId: string, output: unknown) => Promise<boolean | null>;
  /** Where juror verdicts come from. Without one, jury swarms wait in Verifying. */
  jury?: JuryAdapter;
  now?: Date;
};

/**
 * Moves one submitted result into verification. A result whose schema cannot be checked here stays
 * Submitted; one with an invalid schema or signature is rejected with a record.
 */
export async function intakeResult(resultId: string, deps: PipelineDeps = {}) {
  const now = deps.now ?? new Date();
  const db = await getDb();
  const f0 = await facts(db, resultId);
  if (!f0 || f0.lease.status !== 'submitted' || f0.result.disposition !== 'on_time') return f0?.lease.status ?? null;
  // Outside the transaction: the schema check reads the bundle and may query the database itself.
  const schemaValid = f0.result.schemaValid ?? (deps.schemaCheck ? await deps.schemaCheck(f0.task.releaseId, f0.result.outputJson) : null);
  return db.transaction(async (tx) => {
    const f = await facts(tx, resultId);
    if (!f || f.lease.status !== 'submitted') return f?.lease.status ?? null;
    if (schemaValid === null) return 'submitted' as const;
    if (f.result.schemaValid === null) await tx.update(results).set({ schemaValid }).where(eq(results.id, f.result.id));
    const signatureOk = await runRecordSignatureOk(tx, f);
    if (!schemaValid || !signatureOk) {
      const method = methodsOf(f)[0]!;
      await writeRecord(tx, f, method, { outcome: 'rejected', rationaleCode: schemaValid ? 'run_record_signature_invalid' : 'schema_invalid', evidenceHashes: [f.result.outputHash], verifierVersion: INTAKE_VERSION });
      await reject(tx, f, now);
      return 'rejected' as const;
    }
    await tx.update(leases).set({ status: 'verifying', verifyingAt: now }).where(and(eq(leases.id, f.lease.id), eq(leases.status, 'submitted')));
    return 'verifying' as const;
  });
}

/* ----------------------------------------------------------------------------
 * Coordinator-side methods: known answers, redundancy, jury
 * ------------------------------------------------------------------------- */

async function nodeFlagged(tx: Tx, nodeId: string, swarmId: string) {
  const rows = await tx
    .select({ id: verificationRecords.id })
    .from(verificationRecords)
    .innerJoin(leases, eq(leases.id, verificationRecords.leaseId))
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .where(and(eq(leases.nodeId, nodeId), eq(tasks.swarmId, swarmId), eq(verificationRecords.method, 'known-answers'), eq(verificationRecords.outcome, 'rejected')))
    .limit(1);
  return rows.length > 0;
}

async function runKnownAnswers(tx: Tx, f: Facts): Promise<Verdict | null> {
  const [known] = await tx.select().from(taskKnownAnswers).where(eq(taskKnownAnswers.taskId, f.task.id)).limit(1);
  if (known) return knownAnswersVerifier.verify({ kind: 'known', expected: known.expectedJson as Record<string, unknown>, output: f.result.outputJson });
  return knownAnswersVerifier.verify({ kind: 'ordinary', nodeFlagged: await nodeFlagged(tx, f.lease.nodeId, f.swarm.id) });
}

async function runRedundancy(tx: Tx, f: Facts, rule: VerificationRule, now: Date) {
  if (!f.task.redundancyGroup) return;
  const group = await tx
    .select({ result: results, lease: leases })
    .from(results)
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .where(and(eq(tasks.swarmId, f.swarm.id), eq(tasks.redundancyGroup, f.task.redundancyGroup), eq(results.disposition, 'on_time'), ne(leases.status, 'submitted')))
    .orderBy(asc(results.submittedAt), asc(results.id));
  const verdicts = redundancyVerdicts(
    group.map((g) => ({ resultId: g.result.id, accountId: g.lease.accountId, nodeId: g.lease.nodeId, outputHash: g.result.outputHash })),
    rule.redundancyCount,
  );
  if (!verdicts) return;
  for (const g of group) {
    const v = verdicts.get(g.result.id);
    const gf = await facts(tx, g.result.id);
    if (!v || !gf || gf.lease.status !== 'verifying') continue;
    await writeRecord(tx, gf, 'redundancy', v);
    await decide(tx, gf, now);
  }
}

async function runJury(f: Facts, rule: VerificationRule, jury: JuryAdapter | undefined): Promise<Verdict | null> {
  if (!jury) return null;
  const subject = { resultId: f.result.id, taskKey: f.task.coordinatorTaskId, outputHash: f.result.outputHash, submitter: { accountId: f.lease.accountId, nodeId: f.lease.nodeId } };
  const verdicts = await jury.verdictsFor(subject);
  if (!verdicts) return null;
  return juryVerifier.verify({ subject, verdicts, panelSize: rule.juryPanelSize, minFamilies: f.manifest.models.diversity?.min_families ?? null });
}

/** Runs the coordinator-side methods a verifying result still lacks, then decides. */
export async function runCoordinatorMethods(resultId: string, deps: PipelineDeps = {}) {
  const now = deps.now ?? new Date();
  const db = await getDb();
  const f0 = await facts(db, resultId);
  if (!f0 || f0.lease.status !== 'verifying') return;
  const rule0 = await currentVerificationRule(db, f0.swarm.id);
  // The jury adapter may call out, so it runs before the transaction.
  const juryVerdict = methodsOf(f0).includes('jury') ? await runJury(f0, rule0, deps.jury) : null;
  await db.transaction(async (tx) => {
    const f = await facts(tx, resultId);
    if (!f || f.lease.status !== 'verifying') return;
    const rule = await currentVerificationRule(tx, f.swarm.id);
    const have = new Set((await tx.select({ m: verificationRecords.method }).from(verificationRecords).where(eq(verificationRecords.resultId, f.result.id))).map((r) => r.m));
    for (const method of methodsOf(f)) {
      if (have.has(method)) continue;
      if (method === 'known-answers') {
        const v = await runKnownAnswers(tx, f);
        if (v) await writeRecord(tx, f, method, v);
      } else if (method === 'jury' && juryVerdict) await writeRecord(tx, f, method, juryVerdict);
      else if (method === 'redundancy') {
        await runRedundancy(tx, f, rule, now);
        return;
      }
      // machine-check: the verifier worker. publisher-review: the publisher's review queue (M9).
    }
    await decide(tx, f, now);
  });
}

/* ----------------------------------------------------------------------------
 * Verifier worker: work list and signed verdicts
 * ------------------------------------------------------------------------- */

export type WorkItem = {
  subject: { type: 'result' | 'qualification_attempt'; id: string };
  swarm: string;
  release_id: string;
  harness: string;
  checker: (typeof MACHINE_CHECKERS)[string] | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  output_sha256: string;
};

/** Results and qualification answers waiting for a machine check, oldest first. */
export async function machineCheckWork(limit = 10): Promise<WorkItem[]> {
  const db = await getDb();
  const rows = await db
    .select({ result: results, task: tasks, release: swarmReleases, swarm: swarms })
    .from(results)
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .innerJoin(swarmReleases, eq(swarmReleases.id, tasks.releaseId))
    .innerJoin(swarms, eq(swarms.id, tasks.swarmId))
    .leftJoin(verificationRecords, and(eq(verificationRecords.resultId, results.id), eq(verificationRecords.method, 'machine-check')))
    .where(and(eq(leases.status, 'verifying'), isNull(verificationRecords.id), sql`${swarmReleases.manifestJson}->'verification' ? 'machine-check'`))
    .orderBy(asc(leases.verifyingAt), asc(results.id))
    .limit(limit);
  const items: WorkItem[] = rows.map((r) => {
    const m = r.release.manifestJson as ManifestV1;
    return { subject: { type: 'result', id: r.result.id }, swarm: r.swarm.slug, release_id: r.release.id, harness: m.harness.name, checker: MACHINE_CHECKERS[m.harness.name] ?? null, input: (r.task.inputJson ?? {}) as Record<string, unknown>, output: (r.result.outputJson ?? {}) as Record<string, unknown>, output_sha256: r.result.outputHash };
  });
  if (items.length >= limit) return items;
  const quals = await db
    .select({ attempt: qualificationAttempts, task: qualificationTasks, q: qualifications, release: swarmReleases, swarm: swarms })
    .from(qualificationAttempts)
    .innerJoin(qualificationTasks, eq(qualificationTasks.id, qualificationAttempts.taskId))
    .innerJoin(qualifications, eq(qualifications.id, qualificationAttempts.qualificationId))
    .innerJoin(swarmReleases, eq(swarmReleases.id, qualifications.releaseId))
    .innerJoin(swarms, eq(swarms.id, qualificationTasks.swarmId))
    .where(eq(qualificationAttempts.checkStatus, 'awaiting'))
    .orderBy(asc(qualificationAttempts.submittedAt))
    .limit(limit - items.length);
  for (const r of quals) {
    const m = r.release.manifestJson as ManifestV1;
    items.push({ subject: { type: 'qualification_attempt', id: r.attempt.id }, swarm: r.swarm.slug, release_id: r.release.id, harness: m.harness.name, checker: MACHINE_CHECKERS[m.harness.name] ?? null, input: r.task.inputJson as Record<string, unknown>, output: (r.attempt.outputJson ?? {}) as Record<string, unknown>, output_sha256: r.attempt.outputHash ?? '' });
  }
  return items;
}

/**
 * A signed machine-check verdict from a verifier worker (SPEC 13.3 `POST /verifications`). The
 * platform checks the key, the record signature and the assignment: the subject must be waiting for
 * this method and the record must name the stored output hash. Idempotent per subject and method.
 */
export async function recordWorkerVerdict(o: { keyId: string; payload: RecordPayload; signature: string; now?: Date }) {
  const now = o.now ?? new Date();
  const key = await verifierKey(o.keyId);
  if (!key || key.status !== 'active' || key.kind !== 'worker') throw err(401, 'unknown_verifier', 'That verifier key is not registered.');
  if (!key.methods.includes(o.payload.method)) throw err(403, 'method_not_allowed', 'This verifier may not decide that method.');
  const sig = splitSignature(o.signature);
  if (!sig || sig.keyId !== o.keyId || !verifySignature(key.publicKey, verificationRecordMessage(o.payload), sig.signature)) throw err(401, 'record_signature_invalid', 'The verification record signature did not verify.');
  const db = await getDb();
  if (o.payload.subject_type === 'qualification_attempt') return recordQualificationCheck(o.payload, o.signature, now);
  return db.transaction(async (tx) => {
    const f = await facts(tx, o.payload.subject_id);
    if (!f) throw err(404, 'not_found', 'No such result.');
    const [existing] = await tx.select().from(verificationRecords).where(and(eq(verificationRecords.resultId, f.result.id), eq(verificationRecords.method, o.payload.method))).limit(1);
    if (existing) {
      if (existing.signature === o.signature) return { record: existing, status: f.lease.status, duplicate: true };
      throw err(409, 'already_verified', 'This result already has a verdict for that method.');
    }
    if (f.lease.status !== 'verifying') throw err(409, 'not_verifying', `This result is ${f.lease.status}.`);
    if (!methodsOf(f).includes(o.payload.method)) throw err(409, 'method_not_assigned', 'This swarm does not use that verification method.');
    if (o.payload.result_hash !== f.result.outputHash) throw err(409, 'result_hash_mismatch', 'The record names a different output.');
    const verdict: Verdict = { outcome: o.payload.outcome, rationaleCode: o.payload.rationale_code, evidenceHashes: o.payload.evidence_hashes, verifierVersion: o.payload.verifier_version, panel: o.payload.panel };
    const record = await writeRecord(tx, f, o.payload.method, verdict, { keyId: o.keyId, signature: sig.signature });
    await decide(tx, f, now);
    const [l] = await tx.select({ status: leases.status }).from(leases).where(eq(leases.id, f.lease.id));
    return { record: record!, status: l!.status, duplicate: false };
  });
}

/** A machine check on a qualification answer: it now counts as right or wrong, and the round is rescored. */
async function recordQualificationCheck(p: RecordPayload, signature: string, now: Date) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(qualificationAttempts).where(eq(qualificationAttempts.id, p.subject_id)).limit(1);
    if (!a) throw err(404, 'not_found', 'No such qualification answer.');
    if (a.checkStatus !== 'awaiting') {
      if ((a.checkRecordJson as { signature?: string } | null)?.signature === signature) return { record: null, status: a.checkStatus, duplicate: true };
      throw err(409, 'already_verified', 'This answer was already checked.');
    }
    if (p.result_hash !== a.outputHash) throw err(409, 'result_hash_mismatch', 'The record names a different output.');
    const correct = p.outcome === 'accepted';
    await tx.update(qualificationAttempts).set({ correct, checkStatus: correct ? 'accepted' : 'rejected', checkRecordJson: { ...p, signature } }).where(eq(qualificationAttempts.id, a.id));
    await rescoreQualification(tx, a.qualificationId, now);
    return { record: null, status: correct ? 'accepted' : 'rejected', duplicate: false };
  });
}

/** Recounts a qualification round from its answers; passing activates the membership. */
export async function rescoreQualification(tx: Tx, qualificationId: string, now: Date) {
  const [q] = await tx.select().from(qualifications).where(eq(qualifications.id, qualificationId));
  if (!q) return null;
  const [rel] = await tx.select().from(swarmReleases).where(eq(swarmReleases.id, q.releaseId));
  const rule = (rel!.manifestJson as ManifestV1).qualification;
  const all = await tx.select().from(qualificationAttempts).where(and(eq(qualificationAttempts.qualificationId, q.id), isNotNull(qualificationAttempts.submittedAt)));
  const passed = all.filter((x) => x.correct === true).length;
  const wrong = all.filter((x) => x.correct === false).length;
  const outcome = q.outcome !== 'in_progress' ? q.outcome : passed >= rule.pass ? 'passed' : wrong > rule.tasks - rule.pass ? 'failed' : 'in_progress';
  const [updated] = await tx
    .update(qualifications)
    .set({ attempts: all.length, passed, outcome, completedAt: outcome === 'in_progress' ? null : (q.completedAt ?? now) })
    .where(eq(qualifications.id, q.id))
    .returning();
  if (outcome === 'passed' && q.outcome === 'in_progress') {
    const [m] = await tx.select().from(memberships).where(eq(memberships.id, q.membershipId));
    if (m && m.status === 'qualifying') {
      await tx.update(memberships).set({ status: 'active' }).where(eq(memberships.id, m.id));
      await rebalanceShares(tx, m.nodeId);
    }
  }
  return updated ?? null;
}

/* ----------------------------------------------------------------------------
 * Settlement and clawback
 * ------------------------------------------------------------------------- */

/**
 * Pending to Settled (SPEC 9.2 step 5) once the swarm's review window has passed with no fraud
 * found. A swarm without a review window value never settles.
 */
export async function settleDue(now = new Date()) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const pending = await tx
      .select({ lease: leases, swarmId: tasks.swarmId, resultId: results.id })
      .from(leases)
      .innerJoin(tasks, eq(tasks.id, leases.taskId))
      .innerJoin(results, and(eq(results.leaseId, leases.id), eq(results.disposition, 'on_time')))
      .where(eq(leases.status, 'pending'));
    let settled = 0;
    for (const p of pending) {
      const rule = await currentVerificationRule(tx, p.swarmId);
      if (rule.reviewWindowS === null || !p.lease.pendingAt || p.lease.pendingAt.getTime() + rule.reviewWindowS * 1000 > now.getTime()) continue;
      const disputed = await tx.select({ id: verificationRecords.id }).from(verificationRecords).where(and(eq(verificationRecords.resultId, p.resultId), eq(verificationRecords.disputeStatus, 'fraud_found'))).limit(1);
      if (disputed.length) continue;
      const [moved] = await tx.update(leases).set({ status: 'settled', settledAt: now }).where(and(eq(leases.id, p.lease.id), eq(leases.status, 'pending'))).returning({ id: leases.id });
      if (!moved) continue;
      const credited = await settleCredits(tx, { resultId: p.resultId, leaseId: p.lease.id, accountId: p.lease.accountId });
      await tx.insert(outboxEvents).values({ topic: 'credits.settled', payload: { result_id: p.resultId, credits: credited ? true : false } });
      settled++;
    }
    return settled;
  });
}

/**
 * Fraud found while pending (SPEC 8.3, 9.2 step 6): the result is clawed back, its pending credit
 * returns to the pool, its impact is revoked and reputation drops. Settled results are final here;
 * only an append-only reversal under a documented review could change them, which is not built.
 */
export async function clawBack(o: { resultId: string; actorAccountId: string; reason: string; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const f = await facts(tx, o.resultId);
    if (!f) throw err(404, 'not_found', 'No such result.');
    if (f.lease.status === 'clawed_back') return { status: 'clawed_back' as const, duplicate: true };
    if (f.lease.status === 'settled') throw err(409, 'settled_final', 'Settled work can only change through a documented reversal review.');
    if (f.lease.status !== 'pending') throw err(409, 'not_pending', `This result is ${f.lease.status}.`);
    await tx.update(leases).set({ status: 'clawed_back', clawedBackAt: now }).where(eq(leases.id, f.lease.id));
    await tx.update(verificationRecords).set({ disputeStatus: 'fraud_found' }).where(eq(verificationRecords.resultId, f.result.id));
    if (f.swarm.fundedMode === 'funded') await clawbackCredits(tx, { resultId: f.result.id, leaseId: f.lease.id, accountId: f.lease.accountId, swarmId: f.swarm.id });
    await tx.update(impactEvents).set({ revokedAt: now }).where(and(eq(impactEvents.resultId, f.result.id), isNull(impactEvents.revokedAt)));
    await recordReputation(tx, { accountId: f.lease.accountId, nodeId: f.lease.nodeId, swarmId: f.swarm.id, type: 'result_clawed_back', evidenceRef: `result:${f.result.id}` });
    await tx.insert(outboxEvents).values({ topic: 'credits.clawed_back', payload: { result_id: f.result.id, actor: o.actorAccountId, reason: o.reason.slice(0, 500) } });
    return { status: 'clawed_back' as const, duplicate: false };
  });
}

/* ----------------------------------------------------------------------------
 * The lazy pass the API runs
 * ------------------------------------------------------------------------- */

/** Advances every result that can move now: intake, coordinator methods, settlement. */
export async function runVerificationPass(deps: PipelineDeps = {}) {
  const db = await getDb();
  const submitted = await db.select({ id: results.id }).from(results).innerJoin(leases, eq(leases.id, results.leaseId)).where(and(eq(leases.status, 'submitted'), eq(results.disposition, 'on_time'))).limit(100);
  for (const r of submitted) await intakeResult(r.id, deps);
  const verifying = await db.select({ id: results.id }).from(results).innerJoin(leases, eq(leases.id, results.leaseId)).where(and(eq(leases.status, 'verifying'), eq(results.disposition, 'on_time'))).limit(100);
  for (const r of verifying) await runCoordinatorMethods(r.id, deps);
  return { settled: await settleDue(deps.now) };
}

