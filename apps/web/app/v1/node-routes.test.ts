import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { registerInstallResponseSchema } from '@swarm-explorer/api-client';
import { fitCalibrations, getDb, licenseAcceptances, modelArtifacts, models, nodeCapabilities, nodeModels } from '@swarm-explorer/db';
import { runMigrations, seed } from '@swarm-explorer/db/testing';
import { enforcementSupport, hardwareFixture, minimizeCapabilities } from '@swarm-explorer/node-core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { signIn, signed, type Device } from '@/lib/test-device';
import { PUT as putCapabilities } from './nodes/[id]/capabilities/route';
import { POST as registerInstall } from './installs/route';
import { POST as acceptLicense } from './me/license-acceptances/route';
import { GET as getFit } from './models/[id]/fit/route';
import { POST as postBenchmark } from './nodes/[id]/models/[artifact]/benchmark/route';

const install = { app_version: '0.2.0', channel: 'dev', platform: 'darwin', arch: 'arm64' };
const report = JSON.stringify(minimizeCapabilities(hardwareFixture('apple-silicon-32gb')!, enforcementSupport('darwin')));
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let demo: Device;
let other: Device;
let nodeId: string;

beforeAll(async () => {
  await runMigrations();
  await seed();
  demo = await signIn('demo');
  other = await signIn('reviewer');
});

describe('POST /v1/installs (device signed, SPEC 13)', () => {
  it('registers the install and creates its node once', async () => {
    const body = JSON.stringify(install);
    const a = registerInstallResponseSchema.parse(await (await registerInstall(signed(demo, 'POST', '/v1/installs', body), undefined as never)).json());
    const b = registerInstallResponseSchema.parse(await (await registerInstall(signed(demo, 'POST', '/v1/installs', body), undefined as never)).json());
    expect(a.install_id).toBe(demo.installId);
    expect(b.node_id).toBe(a.node_id);
    expect(a.node_status).toBe('setup');
    nodeId = a.node_id;
  });

  it('replays an Idempotency-Key and refuses it for a different body', async () => {
    const key = randomBytes(16).toString('base64url');
    const first = await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify(install), { idem: key }), undefined as never);
    const again = await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify(install), { idem: key }), undefined as never);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    const changed = await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify({ ...install, app_version: '9.9.9' }), { idem: key }), undefined as never);
    expect(changed.status).toBe(422);
  });

  it.each([
    ['a stolen token without the device key', { key: generateKeyPairSync('ed25519').privateKey }, 'device_signature_invalid'],
    ['a stale timestamp', { ts: Date.now() - 10 * 60_000 }, 'device_clock_skew'],
    ['no Idempotency-Key', { idem: null }, 'idempotency_key_required'],
  ])('refuses %s', async (_n, over, code) => {
    const res = await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify(install), over), undefined as never);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).error.code).toBe(code);
  });

  it('refuses a replayed nonce', async () => {
    const nonce = randomBytes(16).toString('base64url');
    expect((await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify(install), { nonce }), undefined as never)).status).toBe(200);
    const res = await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify(install), { nonce }), undefined as never);
    expect((await res.json()).error.code).toBe('device_nonce_reused');
  });

  it('refuses a body that differs from what was signed', async () => {
    const r = signed(demo, 'POST', '/v1/installs', JSON.stringify(install));
    const tampered = new Request(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify({ ...install, channel: 'stable' }) });
    expect((await (await registerInstall(tampered, undefined as never)).json()).error.code).toBe('device_signature_invalid');
  });
});

describe('PUT /v1/nodes/{id}/capabilities', () => {
  it('stores the minimized report', async () => {
    const path = `/v1/nodes/${nodeId}/capabilities`;
    const res = await putCapabilities(signed(demo, 'PUT', path, report), params(nodeId));
    expect(res.status).toBe(200);
    const db = await getDb();
    const rows = await db.select().from(nodeCapabilities).where(eq(nodeCapabilities.nodeId, nodeId));
    expect(rows[0]).toMatchObject({ os: 'darwin', cpuClass: 'apple-silicon', gpuFamily: 'apple', confidence: 'measured' });
  });

  it('rejects extra fields and unrounded sizes', async () => {
    const path = `/v1/nodes/${nodeId}/capabilities`;
    const extra = JSON.stringify({ ...JSON.parse(report), gpu_name: 'Apple M3 Pro' });
    expect((await putCapabilities(signed(demo, 'PUT', path, extra), params(nodeId))).status).toBe(400);
    const exact = JSON.stringify({ ...JSON.parse(report), ram_bytes: 34_359_738_369 });
    expect((await putCapabilities(signed(demo, 'PUT', path, exact), params(nodeId))).status).toBe(400);
  });

  it("another account cannot report for this node", async () => {
    const path = `/v1/nodes/${nodeId}/capabilities`;
    const res = await putCapabilities(signed(other, 'PUT', path, report), params(nodeId));
    expect(res.status).toBe(404);
  });
});

describe('M2: fit, benchmark and license acceptance', () => {
  const artifactOf = async (slug: string) => {
    const db = await getDb();
    const [r] = await db.select({ a: modelArtifacts, m: models }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, slug));
    return r!;
  };
  const bench = (d: Device, hash: string, body: object, node = nodeId) => {
    const path = `/v1/nodes/${node}/models/${hash}/benchmark`;
    return postBenchmark(signed(d, 'POST', path, JSON.stringify(body)), { params: Promise.resolve({ id: node, artifact: hash }) });
  };

  it('GET /v1/models/{id}/fit estimates per node from its capability report', async () => {
    const path = `/v1/models/llama3.3-70b/fit?node_id=${nodeId}`;
    const res = await getFit(signed(demo, 'GET', path, '', { idem: null }), params('llama3.3-70b'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifacts[0]).toMatchObject({ fit_status: 'will_not_fit', basis: 'estimate' });
    const small = await (await getFit(signed(demo, 'GET', `/v1/models/qwen2.5-coder-7b/fit?node_id=${nodeId}`, '', { idem: null }), params('qwen2.5-coder-7b'))).json();
    expect(small.artifacts[0].fit_status).toBe('runs_well');
    const theirs = await getFit(signed(other, 'GET', path, '', { idem: null }), params('llama3.3-70b'));
    expect(theirs.status).toBe(404);
  });

  it('records a verified benchmark; the estimate stands without an approved calibration', async () => {
    const { a } = await artifactOf('qwen2.5-coder-7b');
    const res = await bench(demo, a.contentHash, { verified_hash: a.contentHash, runtime: 'ollama', tokens_per_second: 32, estimated_fit: 'runs_well' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ benchmark_tps: 32, fit_status: 'runs_well', basis: 'estimate', calibration_version: null });
    const db = await getDb();
    const [row] = await db.select().from(nodeModels).where(eq(nodeModels.modelArtifactId, a.id));
    expect(row).toMatchObject({ benchmarkTps: 32, fitStatus: 'runs_well', verifiedHash: a.contentHash });
  });

  it('uses only an approved calibration for benchmark-backed fit', async () => {
    const { a } = await artifactOf('qwen2.5-coder-7b');
    const db = await getDb();
    await db.insert(fitCalibrations).values({ runtime: 'ollama', catalogVersion: a.catalogVersion, runsWellMinTps: 40, runsSlowlyMinTps: 10, status: 'in_review' });
    const draft = await (await bench(demo, a.contentHash, { verified_hash: a.contentHash, runtime: 'ollama', tokens_per_second: 32, estimated_fit: 'runs_well' })).json();
    expect(draft).toMatchObject({ basis: 'estimate', fit_status: 'runs_well' });
    await db.update(fitCalibrations).set({ status: 'approved' }).where(eq(fitCalibrations.runtime, 'ollama'));
    const approved = await (await bench(demo, a.contentHash, { verified_hash: a.contentHash, runtime: 'ollama', tokens_per_second: 32, estimated_fit: 'runs_well' })).json();
    expect(approved).toMatchObject({ basis: 'benchmark', fit_status: 'runs_slowly', calibration_version: a.catalogVersion });
    await db.delete(fitCalibrations);
  });

  it('refuses a hash mismatch, a wrong runtime, extra fields and other accounts', async () => {
    const { a } = await artifactOf('qwen2.5-coder-7b');
    const drifted = `sha256-${'0'.repeat(64)}`;
    const mismatch = await bench(demo, a.contentHash, { verified_hash: drifted, runtime: 'ollama', tokens_per_second: 32, estimated_fit: 'runs_well' });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error.code).toBe('hash_mismatch');
    expect((await bench(demo, a.contentHash, { verified_hash: a.contentHash, runtime: 'llama_cpp', tokens_per_second: 32, estimated_fit: 'runs_well' })).status).toBe(400);
    expect((await bench(demo, a.contentHash, { verified_hash: a.contentHash, runtime: 'ollama', tokens_per_second: 32, estimated_fit: 'runs_well', model_name: 'x' })).status).toBe(400);
    expect((await bench(other, a.contentHash, { verified_hash: a.contentHash, runtime: 'ollama', tokens_per_second: 32, estimated_fit: 'runs_well' })).status).toBe(404);
    expect((await bench(demo, drifted, { verified_hash: drifted, runtime: 'ollama', tokens_per_second: 32, estimated_fit: 'runs_well' })).status).toBe(404);
  });

  it('records license acceptance per user and artifact, only for the listed license', async () => {
    const { a, m } = await artifactOf('llama3.1-8b-gguf');
    const post = (d: Device, body: object) => acceptLicense(signed(d, 'POST', '/v1/me/license-acceptances', JSON.stringify(body)), undefined as never);
    expect((await post(demo, { content_hash: a.contentHash, license_id: 'apache-2.0' })).status).toBe(409);
    const ok = await post(demo, { content_hash: a.contentHash, license_id: m.licenseId });
    expect(ok.status).toBe(200);
    expect((await post(demo, { content_hash: a.contentHash, license_id: m.licenseId })).status).toBe(200);
    const db = await getDb();
    const rows = await db.select().from(licenseAcceptances).where(eq(licenseAcceptances.modelArtifactId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.licenseId).toBe('llama3.1-community');
  });
});
