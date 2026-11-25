import { bundleArchiveSchema, harnessReleaseSchema, modelListSchema, revocationFeedSchema, swarmDetailSchema, swarmListSchema } from '@swarm-explorer/api-client';
import { runMigrations, seed } from '@swarm-explorer/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as catchAll, POST as catchAllPost } from './[...path]/route';
import { GET as harness } from './harnesses/[name]/releases/[version]/route';
import { GET as bundle } from './harnesses/[name]/releases/[version]/bundle/route';
import { GET as models } from './models/route';
import { GET as revocations } from './revocations/route';
import { GET as swarm } from './swarms/[slug]/route';
import { GET as swarms } from './swarms/route';
import { POST as registerInstall } from './installs/route';

const req = (path: string, init?: RequestInit) => new Request(`http://localhost/v1${path}`, init);
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

beforeAll(async () => {
  await runMigrations();
  await seed();
});

describe('/v1 catalog routes', () => {
  it('lists the three launch swarms and filters by category', async () => {
    const all = swarmListSchema.parse(await (await swarms(req('/swarms'))).json());
    expect(all.items.map((s) => s.slug).sort()).toEqual(['challenge-vaults', 'prompt-guard-red-team', 'verafy-dao-juries']);
    const math = swarmListSchema.parse(await (await swarms(req('/swarms?category=mathematics'))).json());
    expect(math.items.map((s) => s.slug)).toEqual(['challenge-vaults']);
    const bad = await swarms(req('/swarms?category=crowdfunding'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('invalid_query');
  });

  it('a funded swarm with no purchases reports an empty pool', async () => {
    const res = await swarm(req('/swarms/verafy-dao-juries'), params({ slug: 'verafy-dao-juries' }));
    const d = swarmDetailSchema.parse(await res.json());
    expect(d.funding).toEqual({ mode: 'funded', creditsPerAcceptedTask: 12, poolStatus: 'empty' });
    expect(d.acceptance).toEqual({ status: 'not_enough_history' });
    expect(d.trust.signatureKeyId).toMatch(/^verafy-local-test-/);
  });

  it('unknown swarms get the error envelope', async () => {
    const res = await swarm(req('/swarms/nope'), params({ slug: 'nope' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'No listed swarm has that id.' } });
  });

  it('serves models, harness releases and the revocation feed', async () => {
    const m = modelListSchema.parse(await (await models()).json());
    expect(m.items.find((x) => x.slug === 'qwen2.5-coder-7b')?.acceptedSwarms).toContain('challenge-vaults');
    const h = harnessReleaseSchema.parse(await (await harness(req('/harnesses/lean-prover/releases/1.4.0'), params({ name: 'lean-prover', version: '1.4.0' }))).json());
    expect(h.bundleHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(h.runtime).toBe('wasm');
    expect(h.signingKey).toMatchObject({ keyId: h.signature.split(':')[0], status: 'active' });
    expect(h.downloadUrl).toBe('http://localhost/v1/harnesses/lean-prover/releases/1.4.0/bundle');
    const a = bundleArchiveSchema.parse(await (await bundle(req('/harnesses/lean-prover/releases/1.4.0/bundle'), params({ name: 'lean-prover', version: '1.4.0' }))).json());
    expect(a.bundleHash).toBe(h.bundleHash);
    expect(Object.keys(a.files)).toContain('harness.wasm');
    const missing = await harness(req('/harnesses/lean-prover/releases/9.9.9'), params({ name: 'lean-prover', version: '9.9.9' }));
    expect(missing.status).toBe(404);
    const r = await revocations(req('/revocations'));
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(revocationFeedSchema.parse(await r.json()).items).toEqual([]);
  });

  it('planned endpoints answer 501 with their milestone; unknown ones 404', async () => {
    const verify = await catchAllPost(req('/verifications', { method: 'POST' }), params({ path: ['verifications'] }));
    expect(verify.status).toBe(501);
    expect((await verify.json()).error.message).toContain('M6');
    const nope = await catchAll(req('/withdrawals'), params({ path: ['withdrawals'] }));
    expect(nope.status).toBe(404);
  });

  it('bearer writes reject missing tokens before anything else', async () => {
    const res = await registerInstall(req('/installs', { method: 'POST', body: '{}' }), undefined as never);
    expect(res.status).toBe(401);
  });
});
