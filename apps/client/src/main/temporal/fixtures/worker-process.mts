/**
 * A node worker process for the durability test (durability.test.ts): the real TemporalEngine,
 * workflows and task activities, with the coordinator replaced by the test's stand-in over HTTP
 * and the sandbox replaced by a timed stand-in harness. The test kills this process mid-task and
 * starts another one to see the task resume and submit once.
 *
 * Env: COORDINATOR (base URL), TEMPORAL_ADDRESS, NAMESPACE, TASK_QUEUE, WORKFLOW_BUNDLE, HARNESS_MS,
 * START_TASK ('1' starts one task workflow and prints its id).
 */
import { createHmac } from 'node:crypto';
import { createBundleActivities, createTaskActivities } from '../activities';
import { TemporalEngine } from '../engine';
import type { SwarmTaskInput } from '../types';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const base = env('COORDINATOR');
const harnessMs = Number(env('HARNESS_MS'));

const tasks = createTaskActivities({
  signedFetch: (method, path, body, key) =>
    fetch(new URL(path, base), { method, headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }),
  signWithDevice: async (m) => createHmac('sha256', 'test-device').update(m).digest('base64url'),
  appVersion: '0.0.0-test',
  guard: () => ({ ok: true }),
  stopFor: () => null,
  registerAbort: () => () => {},
  runSpec: async (_i, leaseId, taskInput) => ({ lease: leaseId, taskInput }) as never,
  run: async (spec, signal) => {
    const s = spec as unknown as { lease: string; taskInput: { q: string } };
    await fetch(new URL('/test/run-started', base), { method: 'POST', body: JSON.stringify({ lease: s.lease, pid: process.pid }) });
    await new Promise((r, j) => {
      const t = setTimeout(r, harnessMs);
      signal.addEventListener('abort', () => (clearTimeout(t), j(new Error('aborted'))));
    });
    return { status: 'ok', output: { answer: s.taskInput.q.toUpperCase() }, detail: 'ok', screen: null, modelCalls: 1, tokens: { input: 1, output: 1 } };
  },
  progress: () => {},
  checkKill: async () => {},
  heartbeatMs: 500,
});
const bundle = createBundleActivities({
  resolve: async () => ({ ok: false, issues: [{ code: 'unused', path: '', message: 'unused' }] }),
  pins: { get: () => null, set: () => {} },
  manifests: { get: () => null, set: () => {}, getPending: () => null, setPending: () => {} },
  hold: () => {},
});

const address = env('TEMPORAL_ADDRESS');
const engine = new TemporalEngine({
  server: { address, start: async () => {}, stop: async () => {} },
  namespace: env('NAMESPACE'),
  taskQueue: env('TASK_QUEUE'),
  workflows: { codePath: env('WORKFLOW_BUNDLE') },
  activities: { ...tasks, ...bundle },
});

await engine.start();
process.stdout.write('ready\n');
if (process.env['START_TASK'] === '1') {
  const input: SwarmTaskInput = {
    nodeId: '00000000-0000-4000-8000-000000000001',
    membershipId: 'm-1',
    swarm: 'demo',
    permissionsHash: `sha256-${'b'.repeat(64)}`,
    harnessHash: `sha256-${'a'.repeat(64)}`,
    model: { contentHash: `sha256-${'c'.repeat(64)}`, slug: 'phi4', displayName: 'Phi-4' },
    timeoutS: 300,
  };
  const { workflowId } = await engine.startTask(input);
  process.stdout.write(`started ${workflowId}\n`);
}
process.on('SIGTERM', () => void engine.stop().then(() => process.exit(0)));
