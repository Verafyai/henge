import { runRecordMessage, runRecordSchema, type MembershipView, type StoreHome } from '@swarm-explorer/api-client';
import { DEFAULT_RUN_RULES, enforcementSupport, type Sensors } from '@swarm-explorer/node-core';
import { canonicalJson } from '@swarm-explorer/schema';
import { REVOCATION_PREFIX, revocationCanonical, sha256Digest, signStatement } from '@swarm-explorer/schema/node';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { RevocationEntry } from '@swarm-explorer/api-client';
import { describe, expect, it, vi } from 'vitest';
import type { HarnessRunResult, HarnessRunSpec, InstalledModel } from '../shared/node';
import type { AuthManager } from './auth';
import type { EncryptedCache } from './cache';
import type { MembershipManager, PreparedRun } from './memberships';
import { KILL_BOUND_MS, KillSwitchWatcher } from './kill-switch';
import { TaskRunner } from './tasks';

const H = (c: string) => `sha256-${c.repeat(64)}`;
const NODE = '00000000-0000-7000-8000-000000000001';
const MEM = '00000000-0000-7000-8000-000000000002';
const input = { policy: 'p', guarded_prompt: 'q' };

const membership = { id: MEM, swarm: 'prompt-guard-red-team', node_id: NODE, status: 'active', share_bp: 10_000, permissions_hash: H('b'), queue: { queued: 1, urgent: 0 } } as unknown as MembershipView;
const model = { contentHash: H('a'), slug: 'phi4-14b', displayName: 'Phi-4 14B' } as InstalledModel;

function lease(n: number, over: Record<string, unknown> = {}) {
  return {
    lease_id: `00000000-0000-7000-8000-00000000010${n}`,
    task_id: `00000000-0000-7000-8000-00000000020${n}`,
    swarm: 'prompt-guard-red-team',
    swarm_release_id: '00000000-0000-7000-8000-000000000300',
    status: 'leased',
    urgent: false,
    deadline_at: new Date(Date.now() + 600_000).toISOString(),
    harness: { version: '1.0.0', hash: H('d') },
    model_requirement: { policy: 'any', allowed_classes: [] },
    input: { uri: 'http://api.test/v1/leases/x/input', sha256: sha256Digest(canonicalJson(input)) },
    output_schema_hash: H('e'),
    reward: { funded: false, credits: null },
    permissions_hash: H('b'),
    ...over,
  };
}

function setup(o: { sensors?: Sensors; run?: (spec: HarnessRunSpec, signal: AbortSignal) => Promise<HarnessRunResult>; leases?: Array<ReturnType<typeof lease>>; kill?: ConstructorParameters<typeof TaskRunner>[0]['kill'] } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const leases = [...(o.leases ?? [lease(1), lease(2)])];
  let paused = false;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const auth = {
    getState: () => ({ status: 'signed_in' }),
    signWithDevice: async (msg: string) => `sig:${sha256Digest(msg)}`.padEnd(86, 'x').slice(0, 86),
    signedFetch: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path.endsWith('/leases') && path.startsWith('/v1/coordinators/')) {
        const l = leases.shift();
        return json({ lease: l ?? null, unavailable: l ? null : { code: 'no_tasks', message: 'none' } }, l ? 201 : 200);
      }
      const id = path.split('/')[3]!;
      if (path.endsWith('/start')) return json({ lease_id: id, input, input_sha256: sha256Digest(canonicalJson(input)), status: 'running', deadline_at: new Date(Date.now() + 600_000).toISOString() });
      if (path.endsWith('/results')) return json({ lease_id: id, result_id: '00000000-0000-7000-8000-000000000999', status: 'submitted', disposition: 'on_time', duplicate: false, awaiting_verification: true }, 201);
      if (path.endsWith('/abandon')) return json({ lease_id: id, status: 'abandoned', requeued: true });
      return json({ error: { code: 'not_found', message: 'no' } }, 404);
    },
  } as unknown as AuthManager;
  const home = { joined: [membership], node: { open_leases: [] } } as unknown as StoreHome;
  const prepared = { release: { bundleHash: H('d') }, accepted: [model.contentHash] } as unknown as PreparedRun;
  const memberships = {
    overview: () => ({ home, jobs: [], granted: {}, error: null, askEqualize: [] }),
    refresh: async () => home,
    prepareRun: async () => prepared,
    pickModel: () => model,
    runSpec: (_m: MembershipView, _p: PreparedRun, _model: unknown, leaseId: string, inp: Record<string, unknown>) => ({ lease: leaseId, input: inp }) as unknown as HarnessRunSpec,
  } as unknown as MembershipManager;
  const store = new Map<string, unknown>();
  const cache = { get: (k: string) => store.get(k) ?? null, set: (k: string, v: unknown) => void store.set(k, v) } as unknown as EncryptedCache;
  let sensors: Sensors = o.sensors ?? { idleSeconds: 600, onBattery: false, thermal: null, cpuLoadPct: null, metered: null };
  const runner = new TaskRunner({
    auth,
    cache: () => cache,
    memberships,
    nodeId: () => NODE,
    isPaused: () => paused,
    run: o.run ?? (async () => ({ status: 'ok', output: { reproduced: false }, detail: 'finished', screen: null, modelCalls: 1, tokens: { input: 40, output: 12 } })),
    sensors: () => sensors,
    support: enforcementSupport('darwin'),
    appVersion: '0.2.0',
    changed: () => undefined,
    tickMs: 60_000,
    ...(o.kill ? { kill: o.kill } : {}),
  });
  return {
    runner,
    calls,
    setPaused: (p: boolean) => (paused = p),
    setSensors: (s: Partial<Sensors>) => (sensors = { ...sensors, ...s }),
    idle: () => expect.poll(() => runner.overview().current === null && calls.length > 0).toBe(true),
  };
}

describe('task runner (SPEC 7.3, 13.3)', () => {
  it('leases nothing while the run rules hold work back', async () => {
    const t = setup({ sensors: { idleSeconds: 10, onBattery: false, thermal: null, cpuLoadPct: null, metered: null } });
    await t.runner.tick();
    expect(t.calls).toEqual([]);
    expect(t.runner.overview()).toMatchObject({ phase: 'blocked', detail: 'Waiting until this computer has been idle for 5 minutes.' });
    t.setSensors({ idleSeconds: 600, onBattery: true });
    await t.runner.tick();
    expect(t.calls).toEqual([]);
    expect(t.runner.rules()).toEqual(DEFAULT_RUN_RULES);
  });

  it('leases, starts with its pins, runs and submits a device-signed run record', async () => {
    const t = setup({ leases: [lease(1)] });
    await t.runner.tick();
    await expect.poll(() => t.runner.overview().history.length).toBe(1);
    expect(t.runner.overview().history[0]).toMatchObject({ outcome: 'submitted', swarm: 'prompt-guard-red-team' });
    const paths = t.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths.slice(0, 3)).toEqual(['POST /v1/coordinators/prompt-guard-red-team/leases', `POST /v1/leases/${lease(1).lease_id}/start`, `POST /v1/leases/${lease(1).lease_id}/results`]);
    expect(t.calls[0]!.body).toEqual({ node_id: NODE, mode: 'local', model_artifact_hash: model.contentHash, reputation_token: null, spend_reservation: null });
    expect(t.calls[1]!.body).toEqual({ harness_hash: H('d'), permissions_hash: H('b'), model_artifact_hash: model.contentHash });
    const submit = t.calls[2]!.body as { output: object; output_sha256: string; run_record: Record<string, unknown> & { signature: string } };
    expect(submit.output_sha256).toBe(sha256Digest(canonicalJson({ reproduced: false })));
    const { signature, ...rec } = submit.run_record;
    expect(rec).toMatchObject({ lease_id: lease(1).lease_id, node_id: NODE, harness_hash: H('d'), tokens: { input: 40, output: 12 }, model: { source: 'local', artifact_hash: model.contentHash }, api_cost: { reported_usd_micros: null } });
    expect(signature).toBe(`sig:${sha256Digest(runRecordMessage(canonicalJson(rec)))}`.padEnd(86, 'x').slice(0, 86));
    expect(t.runner.overview().shares[0]).toMatchObject({ id: MEM, runs: 1 });
  });

  it('a metered run submits record version 2 with its fuel, signed with the rest of the record', async () => {
    const fuel = { meter: 'meter/1' as const, budget: null, used: 10_039 };
    const t = setup({ leases: [lease(1)], run: async () => ({ status: 'ok', output: { reproduced: false }, detail: 'finished', screen: null, modelCalls: 1, fuel }) });
    await t.runner.tick();
    await expect.poll(() => t.runner.overview().history.length).toBe(1);
    const submit = t.calls.find((c) => c.path.endsWith('/results'))!.body as { run_record: Record<string, unknown> & { signature: string } };
    const { signature, ...rec } = submit.run_record;
    expect(rec).toMatchObject({ record_version: 2, metering: { meter: 'meter/1', fuel_used: 10_039, fuel_budget: null } });
    // The stand-in device signature is not base64url; the rest must match the contract.
    expect(runRecordSchema.safeParse({ ...submit.run_record, signature: 'A'.repeat(86) }).error?.issues ?? []).toEqual([]);
    expect(signature).toBe(`sig:${sha256Digest(runRecordMessage(canonicalJson(rec)))}`.padEnd(86, 'x').slice(0, 86));
  });

  it('a run that runs out of fuel is abandoned unpaid and submits nothing', async () => {
    const t = setup({ leases: [lease(1)], run: async () => ({ status: 'fuel_exhausted', output: null, detail: 'Stopped when its fuel budget ran out.', screen: null, modelCalls: 0, fuel: { meter: 'meter/1', budget: 1000, used: 1000 } }) });
    await t.runner.tick();
    await expect.poll(() => t.runner.overview().history.length).toBe(1);
    expect(t.runner.overview().history[0]).toMatchObject({ outcome: 'failed' });
    expect(t.calls.some((c) => c.path.endsWith('/results'))).toBe(false);
    expect(t.calls.find((c) => c.path.endsWith('/abandon'))?.body).toEqual({ reason: 'local_failure' });
  });

  it('Pause stops the run, abandons the lease unpaid and leases nothing until resume', async () => {
    let started = false;
    const t = setup({
      run: (_s, signal) =>
        new Promise((resolve) => {
          started = true;
          signal.addEventListener('abort', () => resolve({ status: 'cancelled', output: null, detail: 'Stopped.', screen: null, modelCalls: 0 }));
        }),
    });
    await t.runner.tick();
    await expect.poll(() => started).toBe(true);
    expect(t.runner.leasedModel()).toBe(model.contentHash);
    t.setPaused(true);
    t.runner.pause();
    await expect.poll(() => t.runner.overview().history.length).toBe(1);
    expect(t.runner.overview().history[0]).toMatchObject({ outcome: 'abandoned', detail: 'Paused. The task went back to the queue, unpaid.' });
    expect(t.calls.find((c) => c.path.endsWith('/abandon'))?.body).toEqual({ reason: 'paused' });
    const n = t.calls.length;
    await t.runner.tick();
    expect(t.calls.length).toBe(n);
    expect(t.runner.overview().phase).toBe('paused');
    expect(t.runner.leasedModel()).toBeNull();
  });

  it('a pin mismatch is abandoned before anything runs, and the swarm is skipped for a while', async () => {
    let ran = 0;
    const t = setup({ leases: [lease(1, { harness: { version: '1.0.0', hash: H('f') } }), lease(2)], run: async () => (ran++, { status: 'ok', output: {}, detail: '', screen: null, modelCalls: 0 }) });
    await t.runner.tick();
    expect(t.calls.map((c) => c.path)).toEqual(['/v1/coordinators/prompt-guard-red-team/leases', `/v1/leases/${lease(1).lease_id}/abandon`]);
    expect(t.calls[1]!.body).toEqual({ reason: 'pin_mismatch' });
    await t.runner.tick();
    expect(ran).toBe(0);
    expect(t.calls).toHaveLength(2);
  });

  it('a run rule stop (the user is back) abandons the running task', async () => {
    let ran = 0;
    const t = setup({
      run: (_s, signal) =>
        new Promise((resolve) => {
          ran++;
          signal.addEventListener('abort', () => resolve({ status: 'cancelled', output: null, detail: 'Stopped.', screen: null, modelCalls: 0 }));
        }),
    });
    await t.runner.tick();
    await expect.poll(() => ran).toBe(1);
    t.setSensors({ idleSeconds: 3 });
    await t.runner.tick();
    await expect.poll(() => t.calls.some((c) => c.path.endsWith('/abandon'))).toBe(true);
    expect(t.calls.find((c) => c.path.endsWith('/abandon'))?.body).toEqual({ reason: 'run_rules' });
    await expect.poll(() => t.runner.overview().phase).toBe('blocked');
    expect(ran).toBe(1);
    t.runner.stop();
  });
});

describe('kill switch in the task runner (SPEC 11.6, M7)', () => {
  it('a running task stops within 60 seconds of a signed stop, abandons unpaid, says why, and leases nothing more', async () => {
    vi.useFakeTimers();
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const pub = { key_id: 'revocation-test', public_key: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url'), status: 'active' as const };
      const items: RevocationEntry[] = [];
      let runner: TaskRunner | null = null;
      const kill = new KillSwitchWatcher({ fetchFeed: async () => ({ items, keys: [] }), pinnedKeys: [pub], onChange: () => runner?.applyKill() });
      let aborted = 0;
      const t = setup({
        kill,
        run: (_s, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = Date.now();
              resolve({ status: 'cancelled', output: null, detail: 'Stopped.', screen: null, modelCalls: 0 });
            });
          }),
      });
      runner = t.runner;
      // Before the first good read of the feed nothing starts.
      await t.runner.tick();
      expect(t.calls).toEqual([]);
      expect(t.runner.overview()).toMatchObject({ phase: 'blocked', detail: 'Waiting to check for platform stops before starting work.' });
      kill.start();
      await vi.advanceTimersByTimeAsync(0);
      await t.runner.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.runner.overview().current?.phase).toBe('running');

      await vi.advanceTimersByTimeAsync(7_000);
      const payload = { revocation_version: 1 as const, id: '00000000-0000-7000-8000-0000000000a1', target_type: 'platform' as const, target_id: '*', action: 'revoke' as const, reason: 'Security review', severity: 'critical' as const, effective_at: new Date().toISOString() };
      const signedPayload = revocationCanonical(payload);
      items.push({ id: payload.id, targetType: 'platform', targetId: '*', reason: payload.reason, severity: 'critical', signedPayload, effectiveAt: payload.effective_at, action: 'revoke', signature: signStatement(REVOCATION_PREFIX, signedPayload, { keyId: pub.key_id, privateKey }) });
      const killedAt = Date.now();
      await vi.advanceTimersByTimeAsync(KILL_BOUND_MS);
      expect(aborted).toBeGreaterThan(0);
      expect(aborted - killedAt).toBeLessThanOrEqual(KILL_BOUND_MS);
      expect(t.calls.find((c) => c.path.endsWith('/abandon'))?.body).toEqual({ reason: 'kill_switch' });
      const o = t.runner.overview();
      expect(o.history[0]).toMatchObject({ outcome: 'abandoned', detail: 'Verafy has stopped all work for now: Security review The task went back to the queue, unpaid.' });
      expect(o).toMatchObject({ current: null, phase: 'blocked', detail: 'Verafy has stopped all work for now: Security review' });
      const leased = t.calls.filter((c) => c.path.endsWith('/leases')).length;
      await t.runner.tick();
      expect(t.calls.filter((c) => c.path.endsWith('/leases')).length).toBe(leased);
      kill.stop();
      t.runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
