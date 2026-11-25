import { hardwareFixture } from '@swarm-explorer/node-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactRef, Detection, InstallOutcomeMsg } from '../shared/node';
import type { AuthManager } from './auth';
import type { EncryptedCache } from './cache';
import { ModelManager, type SupervisorRpc } from './models';

const H = (c: string) => `sha256-${c.repeat(64)}`;
const GB = 1024 ** 3;
const catalog = {
  items: [
    { slug: 'small', displayName: 'Small', source: 'ollama', family: 'x', modelClass: 'c', licenseId: 'apache-2.0', acceptedSwarms: [], artifacts: [{ versionLabel: 'v1', contentHash: H('a'), sizeBytes: 4 * GB, contextLength: 8192, quantization: 'Q4', runtimeFormats: ['ollama'], catalogVersion: 0, sourceRef: 'small:v1' }] },
    { slug: 'other', displayName: 'Other', source: 'ollama', family: 'x', modelClass: 'c', licenseId: 'apache-2.0', acceptedSwarms: [], artifacts: [{ versionLabel: 'v1', contentHash: H('b'), sizeBytes: 5 * GB, contextLength: 8192, quantization: 'Q4', runtimeFormats: ['ollama'], catalogVersion: 0, sourceRef: 'other:v1' }] },
    { slug: 'huge', displayName: 'Huge', source: 'ollama', family: 'x', modelClass: 'c', licenseId: 'apache-2.0', acceptedSwarms: [], artifacts: [{ versionLabel: 'v1', contentHash: H('c'), sizeBytes: 90 * GB, contextLength: 8192, quantization: 'Q4', runtimeFormats: ['ollama'], catalogVersion: 0, sourceRef: 'huge:v1' }] },
  ],
};
const detection: Detection = {
  hardware: hardwareFixture('apple-silicon-32gb')!,
  runtimes: [
    { kind: 'ollama', status: 'found', version: '0.12.3', location: 'http://127.0.0.1:11434', models: [], detail: null },
    { kind: 'llama_cpp', status: 'not_found', version: null, location: null, models: [], detail: null },
  ],
  fixture: 'apple-silicon-32gb',
  detectedAt: 1,
};

function setup(outcome: (a: ArtifactRef) => InstallOutcomeMsg = (a) => ({ ok: true, verifiedHash: a.contentHash, managed: true, location: a.sourceRef })) {
  const store = new Map<string, unknown>();
  const cache = { get: (k: string) => store.get(k) ?? null, set: (k: string, v: unknown) => void store.set(k, structuredClone(v)), delete: (k: string) => void store.delete(k) } as unknown as EncryptedCache;
  const calls: string[] = [];
  const rpc: SupervisorRpc = {
    install: async (a) => (calls.push(`install ${a.sourceRef}`), outcome(a)),
    benchmark: async () => ({ tps: 30, detail: null }),
    remove: async (_r, loc) => (calls.push(`remove ${loc}`), true),
  };
  const mm = new ModelManager({
    auth: { getState: () => ({ status: 'signed_out' }) } as unknown as AuthManager,
    cache: () => cache,
    apiBaseUrl: 'http://api.test',
    rpc,
    detection: () => detection,
    nodeId: () => null,
    changed: () => {},
    fetch: (async () => new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  return { mm, calls };
}

describe('ModelManager guards (SPEC 5.4)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('needs a disk budget, refuses what will not fit, and only installs catalog artifacts', async () => {
    expect(await t.mm.install({ slug: 'small', contentHash: H('a'), acceptLicense: true })).toMatchObject({ ok: false, code: 'no_budget' });
    expect(await t.mm.install({ slug: 'huge', contentHash: H('c'), acceptLicense: true, diskBudgetBytes: 100 * GB })).toMatchObject({ ok: false, code: 'will_not_fit' });
    // A hash the catalog does not list for that model is refused, whatever the renderer sends.
    expect(await t.mm.install({ slug: 'small', contentHash: H('b'), acceptLicense: true, diskBudgetBytes: 20 * GB })).toMatchObject({ ok: false, code: 'not_in_catalog' });
    expect(t.calls).toEqual([]);
  });

  it('installs, benchmarks and makes the first model active', async () => {
    expect(await t.mm.install({ slug: 'small', contentHash: H('a'), acceptLicense: true, diskBudgetBytes: 20 * GB })).toEqual({ ok: true });
    const o = t.mm.overview();
    expect(o.storage).toEqual({ diskBudgetBytes: 20 * GB, activeModel: H('a') });
    // Fit stays the memory fact; the benchmark adds only measured tokens per second (decision 2026-11-25).
    expect(o.installed[0]).toMatchObject({ benchmarkTps: 30, fit: { status: 'runs_well', basis: 'estimate' } });
    expect(o.installed[0]!.fit.reason).not.toMatch(/benchmark/);
    expect(o.acceptedLicenses).toEqual([H('a')]);
  });

  it('records a hash mismatch as blocked and installs nothing', async () => {
    t = setup((a) => ({ ok: false, reason: 'hash_mismatch', expected: a.contentHash, actual: H('f'), detail: 'mismatch' }));
    expect(await t.mm.install({ slug: 'small', contentHash: H('a'), acceptLicense: true, diskBudgetBytes: 20 * GB })).toMatchObject({ ok: false, code: 'hash_mismatch' });
    expect(t.mm.overview()).toMatchObject({ installed: [], blocked: [{ contentHash: H('a'), actual: H('f') }] });
  });

  it('a supervisor "ok" with the wrong hash is still refused', async () => {
    t = setup(() => ({ ok: true, verifiedHash: H('e'), managed: true, location: 'x' }));
    expect(await t.mm.install({ slug: 'small', contentHash: H('a'), acceptLicense: true, diskBudgetBytes: 20 * GB })).toMatchObject({ ok: false, code: 'hash_mismatch' });
    expect(t.mm.installed()).toEqual([]);
  });

  it('never evicts or removes the active model; suggests only removable least-used ones', async () => {
    await t.mm.install({ slug: 'small', contentHash: H('a'), acceptLicense: true, diskBudgetBytes: 20 * GB });
    await t.mm.install({ slug: 'other', contentHash: H('b'), acceptLicense: true });
    expect(await t.mm.remove(H('a'))).toMatchObject({ ok: false, code: 'protected' });
    expect(t.mm.setDiskBudget(8 * GB)).toEqual({ ok: true });
    // Switching the active model moves the protection with it.
    expect(t.mm.setActive(H('b'))).toEqual({ ok: true });
    expect(await t.mm.remove(H('b'))).toMatchObject({ ok: false, code: 'protected' });
    expect(await t.mm.remove(H('a'))).toEqual({ ok: true });
    expect(t.calls).toEqual(['install small:v1', 'install other:v1', 'remove small:v1']);
    expect(t.mm.installed().map((m) => m.contentHash)).toEqual([H('b')]);
  });

  it('never removes a model the user already had in Ollama', async () => {
    t = setup((a) => ({ ok: true, verifiedHash: a.contentHash, managed: false, location: a.sourceRef }));
    await t.mm.install({ slug: 'small', contentHash: H('a'), acceptLicense: true, diskBudgetBytes: 20 * GB });
    await t.mm.install({ slug: 'other', contentHash: H('b'), acceptLicense: true });
    expect(await t.mm.remove(H('b'))).toMatchObject({ ok: false, code: 'not_managed' });
    expect(t.mm.overview().usedBytes).toBe(0);
  });
});
