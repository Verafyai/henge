/**
 * Public results and contribution receipts (SPEC 4.1, 4.2, 14; M7).
 *
 * Public results show only verified work: results that reached Settled, with hashes, pins and the
 * methods that accepted them, plus aggregate counts. They never show task inputs, outputs, nodes,
 * accounts, machine details or anything that ties a result to a person (SPEC 14). Volunteer and funded
 * swarms alike show impact; credit amounts are never public.
 *
 * Receipts: one signed receipt per settled result, issued to its contributor once and kept, so a
 * downloaded receipt never changes. It states what the ledger and verification records say, nothing
 * more; volunteer receipts carry impact and never credits.
 */
import type { ManifestV1 } from '@swarm-explorer/schema';
import { signReceipt, type Receipt, type UnsignedReceipt } from '@swarm-explorer/schema/node';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from './client';
import { MembershipError } from './errors';
import { registeredPlatformKey } from './platform-keys';
import { impactEvents, ledgerEntries, leases, receipts, results, runRecords, swarmReleases, swarms, tasks, verificationRecords } from './schema';
import { uuidv7 } from './uuid';

const METHODS = ['machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review'] as const;
type Method = (typeof METHODS)[number];

export type PublicResultView = {
  resultId: string;
  swarm: string;
  outputSha256: string;
  harness: { name: string; version: string; hash: string };
  modelArtifactHash: string | null;
  verification: Array<{ method: Method; outcome: 'accepted'; verifierVersion: string }>;
  impactUnits: number;
  settledAt: string;
};

async function settledRows(where: ReturnType<typeof and>, limit: number) {
  const db = await getDb();
  return db
    .select({ result: results, lease: leases, swarm: swarms, release: swarmReleases, run: runRecords })
    .from(results)
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .innerJoin(swarms, eq(swarms.id, tasks.swarmId))
    .innerJoin(swarmReleases, eq(swarmReleases.id, tasks.releaseId))
    .leftJoin(runRecords, eq(runRecords.leaseId, leases.id))
    .where(and(eq(leases.status, 'settled'), eq(results.disposition, 'on_time'), where))
    .orderBy(desc(leases.settledAt), desc(results.id))
    .limit(limit);
}

async function views(rows: Awaited<ReturnType<typeof settledRows>>): Promise<PublicResultView[]> {
  const ids = rows.map((r) => r.result.id);
  if (!ids.length) return [];
  const db = await getDb();
  const [records, impacts] = await Promise.all([
    db.select().from(verificationRecords).where(and(inArray(verificationRecords.resultId, ids), eq(verificationRecords.outcome, 'accepted'))),
    db.select().from(impactEvents).where(and(inArray(impactEvents.resultId, ids), isNull(impactEvents.revokedAt))),
  ]);
  return rows.map((r) => {
    const m = r.release.manifestJson as ManifestV1;
    return {
      resultId: r.result.id,
      swarm: r.swarm.slug,
      outputSha256: r.result.outputHash,
      harness: { name: m.harness.name, version: m.harness.version, hash: m.harness.hash },
      modelArtifactHash: r.run?.modelArtifactHash ?? null,
      verification: records
        .filter((v) => v.resultId === r.result.id)
        .sort((a, b) => METHODS.indexOf(a.method) - METHODS.indexOf(b.method))
        .map((v) => ({ method: v.method, outcome: 'accepted' as const, verifierVersion: v.verifierVersion })),
      impactUnits: impacts.find((i) => i.resultId === r.result.id)?.units ?? 0,
      settledAt: r.lease.settledAt!.toISOString(),
    };
  });
}

/** A listed swarm's verified results and aggregate counts. Null for an unknown swarm. */
export async function publicSwarmResults(slug: string, limit = 50) {
  const db = await getDb();
  const [s] = await db.select({ swarm: swarms, release: swarmReleases }).from(swarms).innerJoin(swarmReleases, eq(swarmReleases.swarmId, swarms.id)).where(and(eq(swarms.slug, slug), eq(swarms.status, 'listed'), eq(swarms.visibility, 'public'))).orderBy(desc(swarmReleases.publishedAt)).limit(1);
  if (!s) return null;
  const byStatus = await db
    .select({ status: leases.status, n: sql<string>`count(*)` })
    .from(results)
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .where(and(eq(tasks.swarmId, s.swarm.id), eq(results.disposition, 'on_time')))
    .groupBy(leases.status);
  const n = (...st: string[]) => byStatus.filter((b) => st.includes(b.status)).reduce((a, b) => a + Number(b.n), 0);
  const [impact] = await db
    .select({ n: sql<string>`coalesce(sum(${impactEvents.units}), 0)` })
    .from(impactEvents)
    .innerJoin(results, eq(results.id, impactEvents.resultId))
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .where(and(eq(impactEvents.swarmId, s.swarm.id), isNull(impactEvents.revokedAt), eq(leases.status, 'settled')));
  return {
    swarm: { slug: s.swarm.slug, name: (s.release.manifestJson as ManifestV1).name, funded: s.swarm.fundedMode === 'funded' },
    counts: { settled: n('settled'), pending: n('pending'), inVerification: n('submitted', 'verifying'), rejected: n('rejected', 'clawed_back'), impactSettled: Number(impact?.n ?? 0) },
    items: await views(await settledRows(eq(tasks.swarmId, s.swarm.id), limit)),
  };
}

/** One settled result, publicly. Null unless it settled (pending or rejected work is not public). */
export async function publicResult(resultId: string): Promise<PublicResultView | null> {
  const [v] = await views(await settledRows(and(eq(results.id, resultId), eq(swarms.visibility, 'public')), 1));
  return v ?? null;
}

async function settledCredits(resultId: string): Promise<number> {
  const db = await getDb();
  const [r] = await db.select({ n: sql<string>`coalesce(sum(${ledgerEntries.creditCredits}), 0)` }).from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `settle:${resultId}`));
  return Number(r?.n ?? 0);
}

/**
 * The signed receipt for one of the caller's settled results, issued on first request and then
 * returned unchanged. Refused for someone else's result (404) and for anything not settled (409).
 */
export async function receiptFor(o: { accountId: string; resultId: string; now?: Date }): Promise<Receipt> {
  const db = await getDb();
  const [own] = await db.select({ lease: leases, result: results }).from(results).innerJoin(leases, eq(leases.id, results.leaseId)).where(and(eq(results.id, o.resultId), eq(leases.accountId, o.accountId))).limit(1);
  if (!own) throw new MembershipError(404, 'not_found', 'No result of yours with that id.');
  const [kept] = await db.select().from(receipts).where(eq(receipts.resultId, o.resultId)).limit(1);
  if (kept) return kept.receiptJson as Receipt;
  if (own.lease.status !== 'settled' || own.result.disposition !== 'on_time') throw new MembershipError(409, 'not_settled', 'A receipt is issued once the result has settled.');

  const [row] = await settledRows(eq(results.id, o.resultId), 1);
  const [view] = await views(row ? [row] : []);
  if (!row || !view || !view.verification.length) throw new MembershipError(409, 'not_settled', 'A receipt is issued once the result has settled.');
  const records = await db.select().from(verificationRecords).where(and(eq(verificationRecords.resultId, o.resultId), eq(verificationRecords.outcome, 'accepted')));
  const funded = row.swarm.fundedMode === 'funded';
  const credits = funded ? await settledCredits(o.resultId) : 0;
  const key = await registeredPlatformKey(db, 'receipt');
  const unsigned: UnsignedReceipt = {
    receipt_version: 1,
    receipt_id: uuidv7(),
    issued_at: (o.now ?? new Date()).toISOString(),
    result: { id: o.resultId, state: 'settled', output_sha256: row.result.outputHash },
    swarm: { slug: row.swarm.slug, funded, release_manifest_hash: row.release.manifestHash },
    pins: { harness: view.harness, model_artifact_hash: view.modelArtifactHash, permissions_hash: row.release.permissionsHash },
    verification: records
      .sort((a, b) => METHODS.indexOf(a.method) - METHODS.indexOf(b.method))
      .map((v) => ({ method: v.method, outcome: 'accepted' as const, verifier_version: v.verifierVersion, verifier_key_id: v.verifierKeyId ?? 'unknown' })),
    timeline: {
      submitted_at: (row.lease.submittedAt ?? row.result.submittedAt).toISOString(),
      pending_at: (row.lease.pendingAt ?? row.lease.settledAt!).toISOString(),
      settled_at: row.lease.settledAt!.toISOString(),
    },
    // Volunteer work never earns credits (SPEC 9.1): only a real settle entry in the ledger counts.
    earned: { impact_units: view.impactUnits, credits: funded && credits > 0 ? credits : null },
    contributor: { account_id: o.accountId },
    signer: { key_id: key.keyId, public_key: key.publicKey },
  };
  const receipt = signReceipt(unsigned, key);
  // A race issues one receipt: the first insert wins and everyone gets that one.
  await db.insert(receipts).values({ resultId: o.resultId, accountId: o.accountId, receiptJson: receipt, keyId: key.keyId }).onConflictDoNothing();
  const [stored] = await db.select().from(receipts).where(eq(receipts.resultId, o.resultId)).limit(1);
  return stored!.receiptJson as Receipt;
}
