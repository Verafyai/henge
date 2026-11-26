/**
 * Known answers and redundancy through the coordinator (SPEC 8.1, 8.3). No launch swarm uses these
 * methods, so this file switches Prompt Guard red team's release to each method in its own database.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@swarm-explorer/schema';
import { sha256Digest } from '@swarm-explorer/schema/node';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from './client';
import { requestLease, startLease, submitResult, uploadTasks } from './coordinator';
import { grantPermissions, leaseQualificationTask, startJoin, submitQualificationResult } from './membership';
import { getSwarm } from './queries';
import { accounts, installs, leases, modelArtifacts, models, nodeModels, nodes, qualificationTasks, swarmReleases, tasks, verificationRecords } from './schema';
import { runMigrations, seed } from './testing';
import { intakeResult, runCoordinatorMethods, setVerificationRule } from './verification';

const PG = 'prompt-guard-red-team';
let demo = '';
let team = '';
let coderHash = '';
type Device = { accountId: string; nodeId: string; key: KeyObject };

async function device(accountId: string): Promise<Device> {
  const db = await getDb();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const [inst] = await db
    .insert(installs)
    .values({ accountId, clientId: 'swarm-explorer-desktop', platform: 'darwin', arch: 'arm64', clientVersion: '0.2.0', channel: 'dev', devicePublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })
    .returning();
  const [node] = await db.insert(nodes).values({ installId: inst!.id, accountId, name: 'Test node', runRulesJson: {} }).returning();
  const [art] = await db.select({ id: modelArtifacts.id, hash: modelArtifacts.contentHash }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, 'phi4-14b'));
  coderHash = art!.hash;
  await db.insert(nodeModels).values({ nodeId: node!.id, modelArtifactId: art!.id, verifiedHash: art!.hash, fitStatus: 'runs_well' });
  const d = { accountId, nodeId: node!.id, key: privateKey };
  const s = (await getSwarm(PG))!;
  const { membership } = await startJoin({ accountId, nodeId: d.nodeId, slug: PG, manifestHash: s.release.manifestHash });
  await grantPermissions({ accountId, membershipId: membership.id, permissionsHash: s.release.permissionsHash });
  const known = await db.select().from(qualificationTasks).where(eq(qualificationTasks.swarmId, s.swarm.id));
  for (let i = 0; i < 2; i++) {
    const l = await leaseQualificationTask({ accountId, membershipId: membership.id });
    const output = known.find((k) => k.id === l.task.id)!.expectedJson as Record<string, unknown>;
    await submitQualificationResult({ accountId, membershipId: membership.id, taskId: l.task.id, output, outputHash: sha256Digest(canonicalJson(output)) });
  }
  return d;
}

/** Leases the next task, runs nothing, and submits `output` with a device-signed run record. */
async function work(d: Device, output: Record<string, unknown>) {
  const s = (await getSwarm(PG))!;
  const { grant, reason } = await requestLease({ accountId: d.accountId, nodeId: d.nodeId, slug: PG, modelArtifactHash: coderHash, idempotencyKey: `k-${Math.random()}` });
  if (!grant) return { reason };
  await startLease({ accountId: d.accountId, leaseId: grant.lease.id, pins: { harnessHash: s.manifest.harness.hash, permissionsHash: s.release.permissionsHash, modelArtifactHash: coderHash } });
  const record = { lease_id: grant.lease.id, node_id: d.nodeId, output_sha256: sha256Digest(canonicalJson(output)) };
  const signature = sign(null, Buffer.from(`swarm-explorer-run-record-v1\n${canonicalJson(record)}`), d.key).toString('base64url');
  const r = await submitResult({ accountId: d.accountId, leaseId: grant.lease.id, output, outputHash: record.output_sha256, schemaValid: true, run: { modelIdClaim: 'm', modelArtifactHash: coderHash, provider: null, harnessHash: s.manifest.harness.hash, tokensIn: null, tokensOut: null, elapsedMs: 1, costUsdMicrosReported: null, signature, record: { ...record, signature } } });
  await intakeResult(r.result.id);
  await runCoordinatorMethods(r.result.id);
  const [l] = await (await getDb()).select({ status: leases.status }).from(leases).where(eq(leases.id, grant.lease.id));
  return { grant, resultId: r.result.id, status: l!.status };
}

async function useMethod(method: string) {
  const db = await getDb();
  await db.update(swarmReleases).set({ manifestJson: sql`jsonb_set(${swarmReleases.manifestJson}, '{verification}', ${JSON.stringify([method])}::jsonb)` });
  const s = (await getSwarm(PG))!;
  await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.swarmId, s.swarm.id));
}

const yes = { reproduced: true, attack: 'a' };
const no = { reproduced: false, attack: null };

beforeAll(async () => {
  await runMigrations();
  await seed();
  const db = await getDb();
  const rows = await db.select({ id: accounts.id, handle: accounts.handle }).from(accounts);
  demo = rows.find((r) => r.handle === 'demo')!.id;
  team = rows.find((r) => r.handle === 'verafy-team')!.id;
}, 60_000);

describe('known answers mixed into the queue', () => {
  it('compares hidden answers, never reveals which tasks are known, and flags a node that fails one', async () => {
    const a = await device(demo);
    const b = await device(team);
    await useMethod('known-answers');
    await uploadTasks({
      accountId: team,
      slug: PG,
      tasks: [
        { coordinator_task_id: 'ka-1', input: { guarded_prompt: '1' }, known_answer: { reproduced: false } },
        { coordinator_task_id: 'ka-2', input: { guarded_prompt: '2' }, known_answer: { reproduced: false } },
      ],
    });
    // Ordinary work queued after the known answers.
    await uploadTasks({ accountId: team, slug: PG, tasks: [{ coordinator_task_id: 'plain-1', input: { guarded_prompt: '3' } }, { coordinator_task_id: 'plain-2', input: { guarded_prompt: '4' } }] });
    const right = await work(a, no);
    expect(right.status).toBe('pending');
    // The lease a node sees is the same shape for known and ordinary tasks.
    expect(JSON.stringify(right.grant)).not.toMatch(/known|expected/i);
    const wrong = await work(a, yes);
    expect(wrong.status).toBe('rejected');
    const db = await getDb();
    const [rec] = await db.select().from(verificationRecords).where(eq(verificationRecords.resultId, wrong.resultId!));
    expect(rec).toMatchObject({ method: 'known-answers', rationaleCode: 'known_answer_mismatch' });
    expect(JSON.stringify(rec)).not.toContain('"reproduced"');
    // A flagged node's ordinary work waits for review; an unflagged node's is accepted.
    expect((await work(a, yes)).status).toBe('verifying');
    expect((await work(b, yes)).status).toBe('pending');
  });

  it('refuses known answers for a swarm that does not use the method', async () => {
    await useMethod('machine-check');
    await expect(uploadTasks({ accountId: team, slug: PG, tasks: [{ coordinator_task_id: 'x', input: {}, known_answer: { a: 1 } }] })).rejects.toMatchObject({ code: 'known_answers_not_used' });
  });
});

describe('redundancy across independent accounts', () => {
  it('refuses uploads until a redundancy count is configured; never invents one', async () => {
    await useMethod('redundancy');
    await expect(uploadTasks({ accountId: team, slug: PG, tasks: [{ coordinator_task_id: 'r0', input: {} }] })).rejects.toMatchObject({ code: 'redundancy_unconfigured' });
  });

  it('sends each replica to a different account and accepts the answers that agree', async () => {
    await setVerificationRule({ swarmSlug: PG, redundancyCount: 2, notes: 'test count' });
    const a1 = await device(demo);
    const a2 = await device(demo);
    const b = await device(team);
    expect(await uploadTasks({ accountId: team, slug: PG, tasks: [{ coordinator_task_id: 'r1', input: { guarded_prompt: 'r1' } }] })).toEqual({ accepted: 1, duplicates: 0 });
    const first = await work(a1, no);
    expect(first.status).toBe('verifying');
    // Another node of the same account never gets the second replica.
    expect(await work(a2, no)).toEqual({ reason: 'no_tasks' });
    const second = await work(b, no);
    expect(second.status).toBe('pending');
    const [l] = await (await getDb()).select({ status: leases.status }).from(leases).where(eq(leases.id, first.grant!.lease.id));
    expect(l!.status).toBe('pending');
  });

  it('rejects every answer when the replicas disagree', async () => {
    const a = await device(demo);
    const b = await device(team);
    await uploadTasks({ accountId: team, slug: PG, tasks: [{ coordinator_task_id: 'r2', input: { guarded_prompt: 'r2' } }] });
    const x = await work(a, no);
    const y = await work(b, yes);
    expect(y.status).toBe('rejected');
    const [l] = await (await getDb()).select({ status: leases.status }).from(leases).where(eq(leases.id, x.grant!.lease.id));
    expect(l!.status).toBe('rejected');
    const [rec] = await (await getDb()).select().from(verificationRecords).where(eq(verificationRecords.resultId, x.resultId!));
    expect(rec!.rationaleCode).toBe('redundancy_no_majority');
  });
});
