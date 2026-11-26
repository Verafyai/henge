import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  leaseAbandonedSchema,
  leaseInputSchema,
  leaseResponseSchema,
  leaseStartedSchema,
  leaseViewSchema,
  registerInstallResponseSchema,
  resultSubmittedSchema,
  runRecordMessage,
  sharesUpdatedSchema,
  storeHomeSchema,
  taskBatchAcceptedSchema,
  type Lease,
} from '@swarm-explorer/api-client';
import { getDb, getSwarm, grantPermissions, leaseQualificationTask, modelArtifacts, models, nodeModels, qualificationTasks, startJoin, submitQualificationResult } from '@swarm-explorer/db';
import { runMigrations, seed } from '@swarm-explorer/db/testing';
import { canonicalJson } from '@swarm-explorer/schema';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { digestOf } from '@/lib/lease-api';
import { signIn, signed, type Device } from '@/lib/test-device';
import { POST as catchAll } from './[...path]/route';
import { POST as requestLease } from './coordinators/[swarm]/leases/route';
import { POST as registerInstall } from './installs/route';
import { POST as abandon } from './leases/[id]/abandon/route';
import { GET as input } from './leases/[id]/input/route';
import { POST as renew } from './leases/[id]/renew/route';
import { POST as results } from './leases/[id]/results/route';
import { GET as getLease } from './leases/[id]/route';
import { POST as start } from './leases/[id]/start/route';
import { PATCH as shares } from './nodes/[id]/shares/route';
import { GET as storeHome } from './store/home/route';

const SLUG = 'prompt-guard-red-team';
const id = (v: string) => ({ params: Promise.resolve({ id: v }) });
let demo: Device;
let reviewer: Device;
let nodeId = '';
let modelHash = '';
let membershipId = '';

async function call(fn: (req: Request, ctx: never) => Promise<Response>, d: Device, method: string, path: string, body: unknown, ctx: unknown, over: Parameters<typeof signed>[4] = {}) {
  const res = await fn(signed(d, method, path, body === undefined ? '' : JSON.stringify(body), over), ctx as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const askLease = (d: Device = demo) => call(requestLease, d, 'POST', `/v1/coordinators/${SLUG}/leases`, { node_id: nodeId, mode: 'local', model_artifact_hash: modelHash, reputation_token: null, spend_reservation: null }, { params: Promise.resolve({ swarm: SLUG }) });

function runRecord(lease: Lease, output: object, key = demo.privateKey) {
  const rec = {
    lease_id: lease.lease_id,
    node_id: nodeId,
    model: { source: 'local' as const, claimed_id: 'phi4-14b', artifact_hash: modelHash },
    harness_hash: lease.harness.hash,
    tokens: { input: 40, output: 12 },
    elapsed_ms: 1234,
    api_cost: { reported_usd_micros: null, provider_request_ids: [] },
    output_sha256: digestOf(output),
    client_version: '0.2.0',
  };
  return { ...rec, signature: sign(null, Buffer.from(runRecordMessage(canonicalJson(rec))), key).toString('base64url') };
}

beforeAll(async () => {
  await runMigrations();
  await seed();
  demo = await signIn('demo');
  reviewer = await signIn('reviewer');
  const r = registerInstallResponseSchema.parse(await (await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify({ app_version: '0.2.0', channel: 'dev', platform: 'darwin', arch: 'arm64' })), undefined as never)).json());
  nodeId = r.node_id;
  const db = await getDb();
  const [art] = await db.select({ id: modelArtifacts.id, hash: modelArtifacts.contentHash }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, 'phi4-14b'));
  modelHash = art!.hash;
  await db.insert(nodeModels).values({ nodeId, modelArtifactId: art!.id, verifiedHash: art!.hash, fitStatus: 'runs_well' });
  // Join and qualify directly; the signed join routes have their own tests.
  const s = (await getSwarm(SLUG))!;
  const accountId = (await db.query.accounts.findFirst({ where: (a, { eq: e }) => e(a.handle, 'demo') }))!.id;
  const { membership } = await startJoin({ accountId, nodeId, slug: SLUG, manifestHash: s.release.manifestHash });
  membershipId = membership.id;
  await grantPermissions({ accountId, membershipId, permissionsHash: s.release.permissionsHash });
  const known = await db.select().from(qualificationTasks).where(eq(qualificationTasks.swarmId, s.swarm.id));
  for (let i = 0; i < 2; i++) {
    const l = await leaseQualificationTask({ accountId, membershipId });
    const output = known.find((k) => k.id === l.task.id)!.expectedJson as Record<string, unknown>;
    await submitQualificationResult({ accountId, membershipId, taskId: l.task.id, output, outputHash: digestOf(output) });
  }
});

describe('task protocol over the signed API (SPEC 13.3)', () => {
  let lease: Lease;
  const output = { reproduced: false, attack: null };

  it('store home shows queued work, and an unsigned or foreign caller gets nothing', async () => {
    const home = storeHomeSchema.parse((await call(storeHome, demo, 'GET', `/v1/store/home?node_id=${nodeId}`, undefined, {})).body);
    expect(home.joined[0]).toMatchObject({ swarm: SLUG, status: 'active', queue: { queued: 3, urgent: 0 } });
    expect(home.node).toMatchObject({ shares_customized: false, open_leases: [] });
    const unsigned = await requestLease(new Request(`http://localhost/v1/coordinators/${SLUG}/leases`, { method: 'POST', body: '{}' }), { params: Promise.resolve({ swarm: SLUG }) });
    expect(unsigned.status).toBe(401);
    expect((await askLease(reviewer)).status).toBe(404);
  });

  it('leases one task with the pins to verify, then starts it and hands out the input', async () => {
    const r = await askLease();
    expect(r.status).toBe(201);
    const body = leaseResponseSchema.parse(r.body);
    lease = body.lease!;
    const s = (await getSwarm(SLUG))!;
    expect(lease).toMatchObject({ swarm: SLUG, status: 'leased', harness: { hash: s.manifest.harness.hash }, permissions_hash: s.release.permissionsHash, reward: { funded: false, credits: null } });
    expect(lease.input.uri).toBe(`http://localhost/v1/leases/${lease.lease_id}/input`);
    // One local lease at a time.
    expect((await askLease()).body).toMatchObject({ error: { code: 'concurrency_limit' } });
    // The input is not handed out before the pins are checked.
    expect((await call(input, demo, 'GET', `/v1/leases/${lease.lease_id}/input`, undefined, id(lease.lease_id), { idem: null })).body).toMatchObject({ error: { code: 'lease_not_running' } });
    const bad = await call(start, demo, 'POST', `/v1/leases/${lease.lease_id}/start`, { harness_hash: `sha256-${'0'.repeat(64)}`, permissions_hash: lease.permissions_hash, model_artifact_hash: modelHash }, id(lease.lease_id));
    expect(bad.body).toMatchObject({ error: { code: 'pin_mismatch' } });
    const ok = leaseStartedSchema.parse((await call(start, demo, 'POST', `/v1/leases/${lease.lease_id}/start`, { harness_hash: lease.harness.hash, permissions_hash: lease.permissions_hash, model_artifact_hash: modelHash }, id(lease.lease_id))).body);
    expect(digestOf(ok.input)).toBe(lease.input.sha256);
    const again = leaseInputSchema.parse((await call(input, demo, 'GET', `/v1/leases/${lease.lease_id}/input`, undefined, id(lease.lease_id), { idem: null })).body);
    expect(again.input).toEqual(ok.input);
    expect((await call(renew, demo, 'POST', `/v1/leases/${lease.lease_id}/renew`, undefined, id(lease.lease_id))).body).toMatchObject({ error: { code: 'renewal_refused' } });
  });

  it('accepts only a device-signed run record, and submit is idempotent by lease and result hash', async () => {
    const path = `/v1/leases/${lease.lease_id}/results`;
    const other = generateKeyPairSync('ed25519').privateKey;
    const forged = await call(results, demo, 'POST', path, { output, output_sha256: digestOf(output), run_record: runRecord(lease, output, other) }, id(lease.lease_id));
    expect(forged).toMatchObject({ status: 401, body: { error: { code: 'run_record_signature_invalid' } } });
    const mismatch = await call(results, demo, 'POST', path, { output, output_sha256: digestOf({ x: 1 }), run_record: runRecord(lease, output) }, id(lease.lease_id));
    expect(mismatch.body).toMatchObject({ error: { code: 'output_hash_mismatch' } });

    const rec = runRecord(lease, output);
    const first = await call(results, demo, 'POST', path, { output, output_sha256: digestOf(output), run_record: rec }, id(lease.lease_id));
    expect(first.status).toBe(201);
    expect(resultSubmittedSchema.parse(first.body)).toMatchObject({ status: 'verifying', disposition: 'on_time', duplicate: false, awaiting_verification: true });
    const dup = await call(results, demo, 'POST', path, { output, output_sha256: digestOf(output), run_record: rec }, id(lease.lease_id));
    expect(resultSubmittedSchema.parse(dup.body)).toMatchObject({ duplicate: true, result_id: (first.body as { result_id: string }).result_id });
    const view = leaseViewSchema.parse((await call(getLease, demo, 'GET', `/v1/leases/${lease.lease_id}`, undefined, id(lease.lease_id), { idem: null })).body);
    expect(view).toMatchObject({ lease: { status: 'verifying' }, result: { disposition: 'on_time', output_sha256: digestOf(output) } });
    expect((await call(getLease, reviewer, 'GET', `/v1/leases/${lease.lease_id}`, undefined, id(lease.lease_id), { idem: null })).status).toBe(404);
  });

  it('abandon returns the task to the queue at once, unpaid', async () => {
    const l = leaseResponseSchema.parse((await askLease()).body).lease!;
    const a = leaseAbandonedSchema.parse((await call(abandon, demo, 'POST', `/v1/leases/${l.lease_id}/abandon`, { reason: 'paused' }, id(l.lease_id))).body);
    expect(a).toEqual({ lease_id: l.lease_id, status: 'abandoned', requeued: true });
    const home = storeHomeSchema.parse((await call(storeHome, demo, 'GET', `/v1/store/home?node_id=${nodeId}`, undefined, {})).body);
    expect(home.joined[0]!.queue).toEqual({ queued: 2, urgent: 0 });
    const next = leaseResponseSchema.parse((await askLease()).body).lease!;
    expect(next.task_id).toBe(l.task_id);
    await call(abandon, demo, 'POST', `/v1/leases/${next.lease_id}/abandon`, { reason: 'paused' }, id(next.lease_id));
  });

  it('shares must name every qualified swarm and sum to 10,000', async () => {
    const path = `/v1/nodes/${nodeId}/shares`;
    const bad = await call(shares, demo, 'PATCH', path, { shares: [{ membership_id: membershipId, share_bp: 9000 }] }, id(nodeId));
    expect(bad).toMatchObject({ status: 422, body: { error: { code: 'shares_invalid' } } });
    const ok = sharesUpdatedSchema.parse((await call(shares, demo, 'PATCH', path, { shares: [{ membership_id: membershipId, share_bp: 10_000 }] }, id(nodeId))).body);
    expect(ok).toMatchObject({ customized: false, shares: [{ membership_id: membershipId, share_bp: 10_000 }] });
  });

  it('only the publisher uploads tasks, through tasks:batch', async () => {
    const team = await signIn('verafy-team');
    const req = (d: Device) =>
      new Request(`http://localhost/v1/swarms/${SLUG}/tasks:batch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', 'idempotency-key': randomBytes(16).toString('base64url') },
        body: JSON.stringify({ tasks: [{ coordinator_task_id: 'batch-1', input: { policy: 'p', guarded_prompt: 'q' } }] }),
      });
    const ctx = { params: Promise.resolve({ path: ['swarms', SLUG, 'tasks:batch'] }) };
    expect((await catchAll(req(demo), ctx)).status).toBe(403);
    const ok = await catchAll(req(team), ctx);
    expect(ok.status).toBe(201);
    expect(taskBatchAcceptedSchema.parse(await ok.json())).toEqual({ accepted: 1, duplicates: 0 });
    expect(taskBatchAcceptedSchema.parse(await (await catchAll(req(team), ctx)).json())).toEqual({ accepted: 0, duplicates: 1 });
  });
});
