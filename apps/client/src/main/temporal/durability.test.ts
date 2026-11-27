/**
 * Durability of the node's task workflow (spin-out spec v2, 9.3, 9.6, 10.3), against the real
 * bundled Temporal dev server and the real workflows and activities. The coordinator is a stand-in
 * that answers like the hosted one: Idempotency-Key replay and one result per lease. The node's
 * worker runs in a child process that the test kills with SIGKILL mid-task, then starts again.
 *
 * Scenarios: kill the worker while the harness runs; kill it after the coordinator stored the
 * result but before the worker heard back; kill the worker and the Temporal server together.
 * Each must end with the task completed and exactly one stored result. The test measures and
 * prints completion rate, duplicate results and added latency (DECISIONS records the numbers).
 *
 * Needs the binary from `pnpm --filter @swarm-explorer/client fetch:temporal` (the test script runs it).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import { canonicalJson } from '@swarm-explorer/schema';
import { sha256Digest } from '@swarm-explorer/schema/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TemporalDevServer, temporalBinaryPath } from './server';
import type { TaskOutcome } from './types';
import { RUN_HEARTBEAT_TIMEOUT_S } from './constants';

const APP_ROOT = path.resolve(__dirname, '../../..');
const BINARY = temporalBinaryPath({ isPackaged: false, resourcesPath: '', appRoot: APP_ROOT });
const PORT = 17233;
const NAMESPACE = 'henge-durability-test';
const HARNESS_MS = 3_000;
const WORKER = path.join(__dirname, 'fixtures', 'worker-process.mts');
/** The latest measured numbers, outside git (.data is ignored). */
const REPORT_DIR = path.resolve(APP_ROOT, '../../.data/durability');

/* ------------------------------------------------------------------ stand-in coordinator */

type LeaseRow = { id: string; taskId: string; input: Record<string, unknown>; status: string; deadlineAt: string };
const tasksQueue: Array<{ taskId: string; input: Record<string, unknown> }> = [];
const leases = new Map<string, LeaseRow>();
const stored = new Map<string, string[]>(); // lease id -> stored result hashes
const resultPosts: Array<{ lease: string; replayed: boolean }> = [];
const runStarts: Array<{ lease: string; pid: number }> = [];
const idem = new Map<string, { hash: string; status: number; body: unknown }>();
let holdNextResultMs = 0;

const body = (req: IncomingMessage) => new Promise<string>((r) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => r(b));
});

const DIGEST = (c: string) => `sha256-${c.repeat(64)}`;

async function route(method: string, url: string, raw: string): Promise<{ status: number; body: unknown }> {
  const j = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (url === '/test/run-started') {
    runStarts.push(j as { lease: string; pid: number });
    return { status: 200, body: {} };
  }
  if (method === 'POST' && url === '/v1/coordinators/demo/leases') {
    const t = tasksQueue.shift();
    if (!t) return { status: 200, body: { lease: null, unavailable: { code: 'no_tasks', message: 'No tasks.' } } };
    const id = randomUUID();
    const deadlineAt = new Date(Date.now() + 300_000).toISOString();
    leases.set(id, { id, taskId: t.taskId, input: t.input, status: 'leased', deadlineAt });
    return {
      status: 201,
      body: {
        lease: {
          lease_id: id,
          task_id: t.taskId,
          swarm: 'demo',
          swarm_release_id: randomUUID(),
          status: 'leased',
          urgent: false,
          deadline_at: deadlineAt,
          harness: { version: '1.0.0', hash: DIGEST('a') },
          model_requirement: { policy: 'any', allowed_classes: [] },
          input: { uri: `http://127.0.0.1/v1/leases/${id}/input`, sha256: sha256Digest(canonicalJson(t.input)) },
          output_schema_hash: DIGEST('d'),
          reward: { funded: false, credits: null },
          permissions_hash: DIGEST('b'),
        },
        unavailable: null,
      },
    };
  }
  const m = /^\/v1\/leases\/([^/]+)\/(start|results|abandon|renew)$/.exec(url);
  const l = m ? leases.get(m[1]!) : undefined;
  if (!m || !l) return { status: 404, body: { error: { code: 'not_found', message: 'No such lease.' } } };
  if (m[2] === 'start') {
    if (l.status === 'abandoned') return { status: 409, body: { error: { code: 'lease_abandoned', message: 'Abandoned.' } } };
    l.status = l.status === 'leased' ? 'running' : l.status;
    return { status: 200, body: { lease_id: l.id, status: 'running', deadline_at: l.deadlineAt, input: l.input, input_sha256: sha256Digest(canonicalJson(l.input)) } };
  }
  if (m[2] === 'abandon') {
    if (l.status === 'leased' || l.status === 'running') l.status = 'abandoned';
    return { status: 200, body: { lease_id: l.id, status: l.status, requeued: true } };
  }
  if (m[2] === 'renew') return { status: 409, body: { error: { code: 'renewal_refused', message: 'No renewals.' } } };
  // results: one result per lease, duplicates by hash return the first (as packages/db submitResult).
  const hash = String(j['output_sha256']);
  const prior = stored.get(l.id) ?? [];
  if (prior.includes(hash)) return { status: 200, body: { lease_id: l.id, result_id: randomUUID(), status: 'submitted', disposition: 'on_time', duplicate: true, awaiting_verification: true } };
  if (prior.length) return { status: 409, body: { error: { code: 'already_submitted', message: 'Different result.' } } };
  stored.set(l.id, [hash]);
  l.status = 'submitted';
  if (holdNextResultMs) {
    const ms = holdNextResultMs;
    holdNextResultMs = 0;
    await new Promise((r) => setTimeout(r, ms));
  }
  return { status: 201, body: { lease_id: l.id, result_id: randomUUID(), status: 'submitted', disposition: 'on_time', duplicate: false, awaiting_verification: true } };
}

const coordinator: Server = createServer((req, res) => {
  void body(req).then(async (raw) => {
    const url = req.url ?? '';
    const key = req.headers['idempotency-key'];
    const hash = createHash('sha256').update(`${req.method}\n${url}\n${raw}`).digest('hex');
    const isResult = url.endsWith('/results');
    if (typeof key === 'string' && idem.has(key)) {
      const prev = idem.get(key)!;
      if (prev.hash !== hash) return void res.writeHead(422).end(JSON.stringify({ error: { code: 'idempotency_key_reused', message: 'Reused.' } }));
      if (isResult) resultPosts.push({ lease: url.split('/')[3]!, replayed: true });
      return void res.writeHead(prev.status, { 'content-type': 'application/json', 'idempotent-replay': 'true' }).end(JSON.stringify(prev.body));
    }
    if (isResult) resultPosts.push({ lease: url.split('/')[3]!, replayed: false });
    // Stored before the (possibly held) answer is sent, as the hosted route does in one transaction.
    const answered = await route(req.method ?? 'GET', url, raw);
    if (typeof key === 'string' && answered.status < 500) idem.set(key, { hash, status: answered.status, body: answered.body });
    if (!res.destroyed) res.writeHead(answered.status, { 'content-type': 'application/json' }).end(JSON.stringify(answered.body));
  });
});

/* ------------------------------------------------------------------ node processes */

let base = '';
let bundlePath = '';
let server: TemporalDevServer;
let client: Client;
const work = mkdtempSync(path.join(tmpdir(), 'henge-durability-'));
const children = new Set<ChildProcess>();

function startWorker(o: { startTask: boolean }): Promise<{ child: ChildProcess; workflowId: string | null }> {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER], {
    env: {
      PATH: process.env['PATH'] ?? '',
      COORDINATOR: base,
      TEMPORAL_ADDRESS: `127.0.0.1:${PORT}`,
      NAMESPACE,
      TASK_QUEUE: 'henge-node',
      WORKFLOW_BUNDLE: bundlePath,
      HARNESS_MS: String(HARNESS_MS),
      START_TASK: o.startTask ? '1' : '0',
    },
    cwd: APP_ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return new Promise((resolve, reject) => {
    let out = '';
    let ready = false;
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('ready\n')) ready = true;
      const started = /started (\S+)\n/.exec(out);
      if (ready && (!o.startTask || started)) resolve({ child, workflowId: started?.[1] ?? null });
    });
    child.once('exit', (code) => reject(new Error(`worker exited early (${code}): ${out}`)));
  });
}

const kill = (c: ChildProcess) =>
  new Promise<void>((r) => {
    if (c.exitCode !== null || c.signalCode) return r();
    c.once('exit', () => r());
    c.kill('SIGKILL');
  });

async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const results: Array<{ scenario: string; completed: boolean; stored: number; runs: number; replays: number; ms: number }> = [];

async function runOnce(scenario: 'baseline' | 'kill_during_run' | 'kill_during_submit' | 'kill_worker_and_server') {
  const taskId = randomUUID();
  tasksQueue.push({ taskId, input: { q: `question ${taskId.slice(0, 8)}` } });
  const t0 = Date.now();
  let w = await startWorker({ startTask: true });
  const workflowId = w.workflowId!;
  const leaseOf = () => [...leases.values()].find((l) => l.taskId === taskId)?.id ?? null;
  if (scenario === 'kill_during_run' || scenario === 'kill_worker_and_server') {
    await until(() => runStarts.some((r) => r.lease === leaseOf()), 30_000);
    await new Promise((r) => setTimeout(r, HARNESS_MS / 2));
    await kill(w.child);
    if (scenario === 'kill_worker_and_server') {
      process.kill(server.pid!, 'SIGKILL');
      await until(() => {
        try {
          process.kill(server.pid!, 0);
          return false;
        } catch {
          return true;
        }
      }, 10_000);
      await server.start();
      client = new Client({ connection: await Connection.connect({ address: server.address }), namespace: NAMESPACE });
    }
    w = await startWorker({ startTask: false });
  } else if (scenario === 'kill_during_submit') {
    holdNextResultMs = 2_000;
    await until(() => stored.has(leaseOf() ?? ''), 30_000);
    await kill(w.child);
    w = await startWorker({ startTask: false });
  }
  const outcome = (await client.workflow.getHandle(workflowId).result()) as TaskOutcome;
  const ms = Date.now() - t0;
  await kill(w.child);
  const lease = leaseOf()!;
  const r = {
    scenario,
    completed: outcome.outcome === 'submitted',
    stored: stored.get(lease)?.length ?? 0,
    runs: runStarts.filter((x) => x.lease === lease).length,
    replays: resultPosts.filter((p) => p.lease === lease && p.replayed).length,
    ms,
  };
  results.push(r);
  return { ...r, outcome };
}

const haveBinary = existsSync(BINARY);

describe.runIf(haveBinary)('task workflow survives a killed worker (spin-out 9.6)', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => coordinator.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(coordinator.address() as { port: number }).port}`;
    server = new TemporalDevServer({ binary: BINARY, dataDir: path.join(work, 'temporal'), namespace: NAMESPACE, port: PORT, uiPort: PORT + 1000 });
    await server.start();
    client = new Client({ connection: await Connection.connect({ address: server.address }), namespace: NAMESPACE });
    const { code } = await bundleWorkflowCode({ workflowsPath: path.join(__dirname, 'workflows.ts'), logger: { log: () => {}, trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });
    bundlePath = path.join(work, 'workflows.bundle.js');
    writeFileSync(bundlePath, code);
  }, 120_000);

  afterAll(async () => {
    for (const c of children) await kill(c);
    await server?.stop();
    coordinator.close();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('baseline: a task with no kill completes and stores one result', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await runOnce('baseline');
      expect(r.outcome).toMatchObject({ outcome: 'submitted', duplicate: false });
      expect(r.stored).toBe(1);
      expect(r.runs).toBe(1);
    }
  }, 120_000);

  it('a worker killed while the harness runs resumes on restart and submits once', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await runOnce('kill_during_run');
      expect(r.outcome.outcome).toBe('submitted');
      expect(r.stored).toBe(1);
      // The run step was retried after the heartbeat timeout; the lease was kept, not re-leased.
      expect(r.runs).toBe(2);
    }
  }, 180_000);

  it('a worker killed after the coordinator stored the result does not submit a second one', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await runOnce('kill_during_submit');
      expect(r.outcome).toMatchObject({ outcome: 'submitted', duplicate: true });
      expect(r.stored).toBe(1);
      expect(r.runs).toBe(1);
      // The retried submit sent the identical request, which the coordinator replayed.
      expect(r.replays).toBe(1);
    }
  }, 180_000);

  it('killing the worker and the Temporal server together still completes the task once', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await runOnce('kill_worker_and_server');
      expect(r.outcome.outcome).toBe('submitted');
      expect(r.stored).toBe(1);
    }
  }, 180_000);

  it('reports completion rate, duplicate results and added latency (spin-out 10.3)', () => {
    const by = (s: string) => results.filter((r) => r.scenario === s);
    const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    const baseline = mean(by('baseline').map((r) => r.ms));
    const lines = ['scenario | runs | completed | stored results | extra results | harness runs | submit replays | mean ms | added ms vs baseline'];
    for (const s of ['baseline', 'kill_during_run', 'kill_during_submit', 'kill_worker_and_server']) {
      const rs = by(s);
      if (!rs.length) continue;
      lines.push(
        [s, rs.length, rs.filter((r) => r.completed).length, rs.reduce((a, r) => a + r.stored, 0), rs.reduce((a, r) => a + Math.max(0, r.stored - 1), 0), rs.reduce((a, r) => a + r.runs, 0), rs.reduce((a, r) => a + r.replays, 0), mean(rs.map((r) => r.ms)), s === 'baseline' ? 0 : mean(rs.map((r) => r.ms)) - baseline].join(' | '),
      );
    }
    const report = `Durability (measured, harness ${HARNESS_MS} ms, run heartbeat timeout ${RUN_HEARTBEAT_TIMEOUT_S} s):\n${lines.join('\n')}\n`;
    process.stdout.write(`\n${report}\n`);
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(path.join(REPORT_DIR, 'durability.txt'), report);
    expect(results.every((r) => r.completed)).toBe(true);
    expect(results.every((r) => r.stored === 1)).toBe(true);
  });
});
