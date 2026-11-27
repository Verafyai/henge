/**
 * Result submission is exactly once per lease (spin-out spec v2, 9.3; M5, M6). The node's
 * durable workflow retries a submit with the same Idempotency-Key and the same bytes after a kill;
 * the coordinator replays its first answer, treats the same result under a new key as a duplicate,
 * refuses a different result, and never stores two results for one lease, even when submits race.
 */
import { sign } from 'node:crypto';
import { leaseResponseSchema, resultSubmittedSchema, runRecordMessage, type Lease } from '@swarm-explorer/api-client';
import { getDb, getSwarm, grantPermissions, leaseQualificationTask, modelArtifacts, models, nodeModels, qualificationTasks, results, startJoin, submitQualificationResult, uploadTasks, publishers } from '@swarm-explorer/db';
import { runMigrations, seed } from '@swarm-explorer/db/testing';
import { canonicalJson } from '@swarm-explorer/schema';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { digestOf } from '@/lib/lease-api';
import { signIn, signed, type Device } from '@/lib/test-device';
import { POST as requestLease } from './coordinators/[swarm]/leases/route';
import { POST as registerInstall } from './installs/route';
import { POST as results_ } from './leases/[id]/results/route';
import { POST as start } from './leases/[id]/start/route';

const SLUG = 'prompt-guard-red-team';
const id = (v: string) => ({ params: Promise.resolve({ id: v }) });
let demo: Device;
let nodeId = '';
let modelHash = '';

async function call(fn: (req: Request, ctx: never) => Promise<Response>, method: string, path: string, body: unknown, ctx: unknown = {}, idem?: string) {
  const res = await fn(signed(demo, method, path, JSON.stringify(body), idem ? { idem } : {}), ctx as never);
  return { status: res.status, replayed: res.headers.get('idempotent-replay') === 'true', body: (await res.json()) as Record<string, unknown> };
}

async function leaseAndStart(): Promise<Lease> {
  const r = await call(requestLease, 'POST', `/v1/coordinators/${SLUG}/leases`, { node_id: nodeId, mode: 'local', model_artifact_hash: modelHash, reputation_token: null, spend_reservation: null }, { params: Promise.resolve({ swarm: SLUG }) });
  const lease = leaseResponseSchema.parse(r.body).lease!;
  await call(start, 'POST', `/v1/leases/${lease.lease_id}/start`, { harness_hash: lease.harness.hash, permissions_hash: lease.permissions_hash, model_artifact_hash: modelHash }, id(lease.lease_id));
  return lease;
}

function sealed(lease: Lease, output: Record<string, unknown>, elapsedMs = 10) {
  const rec = { lease_id: lease.lease_id, node_id: nodeId, model: { source: 'local' as const, claimed_id: 'phi4-14b', artifact_hash: modelHash }, harness_hash: lease.harness.hash, tokens: { input: 4, output: 2 }, elapsed_ms: elapsedMs, api_cost: { reported_usd_micros: null, provider_request_ids: [] }, output_sha256: digestOf(output), client_version: '0.2.0' };
  return { output, output_sha256: digestOf(output), run_record: { ...rec, signature: sign(null, Buffer.from(runRecordMessage(canonicalJson(rec))), demo.privateKey).toString('base64url') } };
}

const submit = (lease: Lease, body: unknown, idem?: string) => call(results_, 'POST', `/v1/leases/${lease.lease_id}/results`, body, id(lease.lease_id), idem);
const stored = async (lease: Lease) => (await (await getDb()).select().from(results).where(eq(results.leaseId, lease.lease_id))).length;

beforeAll(async () => {
  await runMigrations();
  await seed();
  demo = await signIn('demo');
  const r = await (await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify({ app_version: '0.2.0', channel: 'dev', platform: 'darwin', arch: 'arm64' })), undefined as never)).json();
  nodeId = (r as { node_id: string }).node_id;
  const db = await getDb();
  const [art] = await db.select({ id: modelArtifacts.id, hash: modelArtifacts.contentHash }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, 'phi4-14b'));
  modelHash = art!.hash;
  await db.insert(nodeModels).values({ nodeId, modelArtifactId: art!.id, verifiedHash: art!.hash, fitStatus: 'runs_well' });
  const s = (await getSwarm(SLUG))!;
  const accountId = (await db.query.accounts.findFirst({ where: (a, { eq: e }) => e(a.handle, 'demo') }))!.id;
  const { membership } = await startJoin({ accountId, nodeId, slug: SLUG, manifestHash: s.release.manifestHash });
  await grantPermissions({ accountId, membershipId: membership.id, permissionsHash: s.release.permissionsHash });
  const known = await db.select().from(qualificationTasks).where(eq(qualificationTasks.swarmId, s.swarm.id));
  for (let i = 0; i < 2; i++) {
    const l = await leaseQualificationTask({ accountId, membershipId: membership.id });
    const output = known.find((k) => k.id === l.task.id)!.expectedJson as Record<string, unknown>;
    await submitQualificationResult({ accountId, membershipId: membership.id, taskId: l.task.id, output, outputHash: digestOf(output) });
  }
  const [pub] = await db.select({ owner: publishers.ownerAccountId }).from(publishers).where(eq(publishers.id, s.swarm.publisherId));
  await uploadTasks({ accountId: pub!.owner, slug: SLUG, tasks: Array.from({ length: 4 }, (_, i) => ({ coordinator_task_id: `idem-${i}`, input: { policy: 'p', guarded_prompt: `idempotency ${i}` } })) });
});

describe('result submission is exactly once per lease', () => {
  const output = { reproduced: false, attack: null };

  it('a retried submit with the same key and bytes replays the first answer; nothing new is stored', async () => {
    const lease = await leaseAndStart();
    const body = sealed(lease, output);
    const key = `henge-result-${lease.lease_id}`;
    const first = await submit(lease, body, key);
    expect(first.status).toBe(201);
    const again = await submit(lease, body, key);
    expect(again).toMatchObject({ status: 201, replayed: true });
    expect(resultSubmittedSchema.parse(again.body).result_id).toBe(resultSubmittedSchema.parse(first.body).result_id);
    expect(await stored(lease)).toBe(1);
  });

  it('the same result under a new key is a duplicate; a different result is refused', async () => {
    const lease = await leaseAndStart();
    expect((await submit(lease, sealed(lease, output))).status).toBe(201);
    // A record signed again (a new elapsed time) for the same output: still the first result.
    const dup = await submit(lease, sealed(lease, output, 99));
    expect(dup.status).toBe(200);
    expect(resultSubmittedSchema.parse(dup.body).duplicate).toBe(true);
    const other = await submit(lease, sealed(lease, { reproduced: false, attack: 'other' }));
    expect(other).toMatchObject({ status: 409, body: { error: { code: 'already_submitted' } } });
    expect(await stored(lease)).toBe(1);
  });

  it('racing submits of one lease store one result', async () => {
    const lease = await leaseAndStart();
    const answers = await Promise.all([submit(lease, sealed(lease, output, 1)), submit(lease, sealed(lease, output, 2)), submit(lease, sealed(lease, { reproduced: false, attack: 'x' }, 3))]);
    expect(answers.filter((a) => a.status === 201)).toHaveLength(1);
    expect(answers.every((a) => [200, 201, 409].includes(a.status))).toBe(true);
    expect(await stored(lease)).toBe(1);
  });
});
