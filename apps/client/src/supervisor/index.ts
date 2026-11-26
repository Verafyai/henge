/**
 * Node supervisor (SPEC 11.1, 11.2): a separate Electron utility process. It detects hardware and
 * runtimes, owns the pause state, (M2) downloads, verifies, benchmarks and removes models, and
 * (M4) verifies signed harness bundles and runs them in the sandbox. Scheduling arrives in M5. It never imports the
 * keychain module and never sees tokens or keys: the main process makes every authenticated call.
 */
import { execFile } from 'node:child_process';
import { access, constants, rm } from 'node:fs/promises';
import path from 'node:path';
import { discoverLlamaCpp, discoverOllama, hardwareFixture, ollamaBaseUrl } from '@swarm-explorer/node-core';
import { detectHardware, systemProbeDeps } from '@swarm-explorer/node-core/probe';
import { HF_DEFAULT_BASE, LLAMA_BENCH_ARGS, hfInstall, ollamaBenchmark, ollamaInstall, ollamaRemove, parseLlamaBench } from '@swarm-explorer/node-core/sources';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  APPROVED_FUEL_BUDGET,
  completeResponseSchema,
  egressFetch,
  grantedCapabilities,
  heuristicScreener,
  mintCapability,
  proxyComplete,
  runHarness,
  runSandboxChecks,
  Scratch,
  verifyBundle,
} from '@swarm-explorer/sandbox';
import type { Detection, HarnessRunResult, HarnessRunSpec, SandboxCheck, SupervisorCommand, SupervisorMessage } from '../shared/node';

type ParentPort = { on(ev: 'message', cb: (e: { data: unknown }) => void): void; postMessage(m: unknown): void };
const port = (process as unknown as { parentPort: ParentPort }).parentPort;

const diskDir = process.env['SWARM_EXPLORER_DISK_DIR'] ?? process.cwd();
// Set by main only for unpackaged test runs.
const fixtureName = process.env['SWARM_EXPLORER_HARDWARE_FIXTURE'] || null;
const modelsDir = process.env['SWARM_EXPLORER_MODELS_DIR'] ?? path.join(diskDir, 'models');
const hfBase = process.env['SWARM_EXPLORER_HF_BASE'] || HF_DEFAULT_BASE;
let paused = false;
const jobs = new Map<number, AbortController>();
let sandbox: { key: Buffer; socketPath: string } | null = null;

/**
 * Sandbox self-check (SPEC 16.4 M3): the hostile-harness suite, plus checks against the live
 * proxy: no capability, a forged one, and (when a model is active) one real capped completion.
 */
async function sandboxCheck(active: { contentHash: string; modelClass: string } | null): Promise<SandboxCheck[]> {
  const results: SandboxCheck[] = await runSandboxChecks({ scratchRoot: path.join(diskDir, 'scratch-check') });
  if (!sandbox) return [...results, { id: 'proxy', title: 'Model proxy is running', passed: false, detail: 'The proxy did not start.' }];
  const ask = { messages: [{ role: 'user' as const, content: 'Reply with OK.' }], max_tokens: 4 };
  const claims = (model: string) => ({ lease: 'self-check', model, model_class: active?.modelClass ?? 'any', max_tokens: 8, max_cost_usd_micros: 0, permissions_hash: `sha256-${'0'.repeat(64)}` });
  const none = await proxyComplete(sandbox.socketPath, 'sxk_none.none', ask).catch(() => ({ status: 0, body: null }));
  results.push({ id: 'proxy-no-capability', title: 'The model proxy refuses calls without a capability', passed: none.status === 401, detail: `HTTP ${none.status}` });
  const forged = mintCapability(Buffer.alloc(32, 7), claims(`sha256-${'0'.repeat(64)}`), 60_000);
  const f = await proxyComplete(sandbox.socketPath, forged, ask).catch(() => ({ status: 0, body: null }));
  results.push({ id: 'proxy-forged', title: 'The model proxy refuses a forged capability', passed: f.status === 401, detail: `HTTP ${f.status}` });
  if (active) {
    const ok = await proxyComplete(sandbox.socketPath, mintCapability(sandbox.key, claims(active.contentHash), 60_000), ask).catch(() => ({ status: 0, body: null }));
    results.push({ id: 'proxy-active-model', title: 'Your active model answers through the proxy, capped at 8 tokens', passed: ok.status === 200, detail: ok.status === 200 ? 'answered' : `HTTP ${ok.status}` });
  }
  return results;
}

const send = (m: SupervisorMessage) => port.postMessage(m);

/** Engineering cap on tokens per model call for a sandboxed task. Not a business value. */
const MAX_TOKENS_PER_CALL = 2048;
const runs = new Map<number, AbortController>();

/**
 * One sandboxed task (SPEC 11.3): verify the signed bundle on disk, mint a capability scoped to
 * this task, model and permission set, and run it. Network and scratch exist only if granted.
 */
async function harnessRun(id: number, spec: HarnessRunSpec): Promise<HarnessRunResult> {
  const empty = { output: null, screen: null, modelCalls: 0 };
  if (!sandbox) return { ...empty, status: 'refused', detail: 'The model proxy is not running.' };
  const proxy = sandbox;
  const check = verifyBundle(spec.bundleDir, spec.release, (k) => (k === spec.key.keyId ? spec.key : undefined), {
    harnessReleases: new Set(spec.revoked.harnessReleases),
    publisherKeys: new Set(spec.revoked.publisherKeys),
  });
  if (!check.ok) return { ...empty, status: 'bundle_rejected', detail: `The harness bundle was refused: ${check.reason}.` };
  const bundle = check.bundle;
  const ctl = new AbortController();
  const tokens = { input: 0, output: 0 };
  runs.set(id, ctl);
  try {
    const wallMs = Math.min(bundle.harness.limits.wall_s, spec.timeoutS) * 1000;
    const token = mintCapability(
      proxy.key,
      { lease: spec.lease, model: spec.model.contentHash, model_class: spec.model.modelClass, max_tokens: MAX_TOKENS_PER_CALL, max_cost_usd_micros: 0, permissions_hash: spec.permissionsHash },
      wallMs + 60_000,
    );
    const scratch = spec.permissions.scratchBytes > 0 ? await Scratch.open(path.join(diskDir, 'scratch'), spec.swarm, spec.permissions.scratchBytes) : null;
    const lookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family === 6 ? (6 as const) : (4 as const) }));
    const r = await runHarness({
      bundle,
      input: spec.input,
      granted: grantedCapabilities(bundle.harness.capabilities, { networkDomains: spec.permissions.network, scratchBytes: spec.permissions.scratchBytes }),
      // Fuel is always counted (meter/1). No fuel budget is approved yet, so it limits nothing (Needs Rex).
      limits: { memoryMb: bundle.harness.limits.memory_mb, wallMs, maxModelCalls: bundle.harness.loop.max_steps, maxTokensPerCall: MAX_TOKENS_PER_CALL, fuel: APPROVED_FUEL_BUDGET },
      host: {
        complete: async (req) => {
          // Pause, leave or a rule stop aborts the run; hanging up cancels the model call in the runtime.
          const res = await proxyComplete(proxy.socketPath, token, req, ctl.signal).catch(() => ({ status: 0, body: null }));
          const body = completeResponseSchema.safeParse(res.body);
          if (res.status === 200 && body.success) {
            tokens.input += body.data.usage.input_tokens;
            tokens.output += body.data.usage.output_tokens;
            return { ok: true, response: body.data };
          }
          const code = (res.body as { error?: { code?: unknown } } | null)?.error?.code;
          return { ok: false, error: typeof code === 'string' ? code.slice(0, 60) : `proxy_http_${res.status}` };
        },
        fetch: spec.permissions.network.length ? (req) => egressFetch(req, { allowed: spec.permissions.network, lookup }) : null,
        scratch,
        screen: heuristicScreener,
      },
      signal: ctl.signal,
    });
    const screen = 'screen' in r ? r.screen : null;
    const fuel = 'fuel' in r ? r.fuel : undefined;
    if (r.status === 'ok') {
      const out = r.output;
      if (!out || typeof out !== 'object' || Array.isArray(out)) return { status: 'invalid_output', output: null, detail: 'The answer was not a JSON object.', screen, modelCalls: r.modelCalls, fuel };
      return { status: 'ok', output: out as Record<string, unknown>, detail: 'finished', screen, modelCalls: r.modelCalls, tokens, fuel };
    }
    if (r.status === 'failed' && r.reason === 'cancelled') return { ...empty, status: 'cancelled', detail: 'Stopped.', screen, fuel };
    // Out of fuel: no output leaves the sandbox, so nothing partial can be submitted.
    if (r.status === 'fuel_exhausted') return { ...empty, status: 'fuel_exhausted', detail: 'Stopped when its fuel budget ran out.', screen, fuel };
    const detail = r.status === 'limit_exceeded' ? `Stopped at the ${r.limit.replace('_', ' ')} limit.` : r.reason;
    return { status: r.status, output: null, detail: detail.slice(0, 400), screen, modelCalls: 0, fuel };
  } finally {
    runs.delete(id);
  }
}

/** PATH lookup without running a shell or the binary itself. */
async function which(bin: string): Promise<string | null> {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean).slice(0, 64)) {
    const p = path.join(dir, bin);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // Not here.
    }
  }
  return null;
}

async function detect(): Promise<Detection> {
  const fixture = fixtureName ? hardwareFixture(fixtureName) : null;
  const hardware = fixture ?? (await detectHardware(systemProbeDeps(), diskDir));
  const [ollama, llama] = await Promise.all([discoverOllama(ollamaBaseUrl(process.env), fetch), discoverLlamaCpp(which)]);
  return { hardware, runtimes: [ollama, llama], fixture: fixture ? fixtureName : null, detectedAt: Date.now() };
}

async function install(id: number, a: Extract<SupervisorCommand, { type: 'install' }>['artifact']) {
  const ctl = new AbortController();
  jobs.set(id, ctl);
  const progress = (completed: number, total: number | null) => send({ type: 'progress', id, completed, total });
  try {
    if (a.runtime === 'ollama') {
      const base = ollamaBaseUrl(process.env);
      if (!base) return { ok: false as const, reason: 'runtime_unavailable' as const, detail: 'OLLAMA_HOST points off this computer.' };
      return await ollamaInstall(base, a.sourceRef, a.contentHash, fetch, progress, ctl.signal);
    }
    return await hfInstall({ base: hfBase, ref: a.sourceRef, expected: a.contentHash, sizeBytes: a.sizeBytes, modelsDir }, fetch, progress, ctl.signal);
  } finally {
    jobs.delete(id);
  }
}

function llamaBench(file: string): Promise<{ tps: number | null; detail: string | null }> {
  return new Promise((resolve) => {
    void which(process.platform === 'win32' ? 'llama-bench.exe' : 'llama-bench').then((bin) => {
      if (!bin) return resolve({ tps: null, detail: 'llama-bench was not found, so no benchmark ran.' });
      execFile(bin, LLAMA_BENCH_ARGS(file), { timeout: 300_000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
        const tps = err ? null : parseLlamaBench(stdout);
        resolve({ tps, detail: tps === null ? 'The benchmark did not produce a result.' : null });
      });
    });
  });
}

async function benchmark(runtime: 'ollama' | 'llama_cpp', location: string): Promise<{ tps: number | null; detail: string | null }> {
  if (runtime === 'ollama') {
    const base = ollamaBaseUrl(process.env);
    const tps = base ? await ollamaBenchmark(base, location, fetch).catch(() => null) : null;
    return { tps, detail: tps === null ? 'Ollama did not return benchmark timings.' : null };
  }
  // Re-verify before first use (SPEC 5.4) is done by main against the stored hash; here we only
  // run files inside our own models folder.
  if (path.dirname(path.resolve(location)) !== path.resolve(modelsDir)) return { tps: null, detail: 'Model file is outside the models folder.' };
  return llamaBench(location);
}

async function remove(runtime: 'ollama' | 'llama_cpp', location: string): Promise<boolean> {
  if (runtime === 'ollama') {
    const base = ollamaBaseUrl(process.env);
    return base ? ollamaRemove(base, location, fetch).catch(() => false) : false;
  }
  if (path.dirname(path.resolve(location)) !== path.resolve(modelsDir)) return false;
  await rm(location, { force: true });
  return true;
}

port.on('message', (e) => {
  const cmd = e.data as SupervisorCommand;
  if (!cmd || typeof cmd !== 'object') return;
  if (cmd.type === 'detect' && Number.isInteger(cmd.id)) {
    void detect().then((detection) => send({ type: 'detected', id: cmd.id, detection }));
  } else if (cmd.type === 'pause' || cmd.type === 'resume') {
    // Pause stops any sandboxed run at once (SPEC 5.2). Leases arrive in M5.
    paused = cmd.type === 'pause';
    if (paused) for (const c of runs.values()) c.abort();
    send({ type: 'paused', paused });
  } else if (cmd.type === 'install' && Number.isInteger(cmd.id)) {
    void install(cmd.id, cmd.artifact).then(
      (outcome) => send({ type: 'installed', id: cmd.id, outcome }),
      () => send({ type: 'installed', id: cmd.id, outcome: { ok: false, reason: 'download_failed', detail: 'The download failed.' } }),
    );
  } else if (cmd.type === 'cancel') {
    jobs.get(cmd.id)?.abort();
  } else if (cmd.type === 'benchmark' && Number.isInteger(cmd.id)) {
    void benchmark(cmd.runtime, cmd.location).then((r) => send({ type: 'benchmarked', id: cmd.id, tps: r.tps, detail: r.detail }));
  } else if (cmd.type === 'sandbox-config' && !sandbox && /^[A-Za-z0-9_-]{43}$/.test(cmd.key)) {
    sandbox = { key: Buffer.from(cmd.key, 'base64url'), socketPath: cmd.socketPath };
  } else if (cmd.type === 'sandbox-check' && Number.isInteger(cmd.id)) {
    void sandboxCheck(cmd.activeModel).then(
      (results) => send({ type: 'sandbox-checked', id: cmd.id, results }),
      (e: unknown) => send({ type: 'sandbox-checked', id: cmd.id, results: [{ id: 'error', title: 'Sandbox checks ran', passed: false, detail: String(e).slice(0, 300) }] }),
    );
  } else if (cmd.type === 'harness-run' && Number.isInteger(cmd.id)) {
    void harnessRun(cmd.id, cmd.run).then(
      (result) => send({ type: 'harness-ran', id: cmd.id, result }),
      (e: unknown) => send({ type: 'harness-ran', id: cmd.id, result: { status: 'failed', output: null, detail: String(e).slice(0, 300), screen: null, modelCalls: 0 } }),
    );
  } else if (cmd.type === 'harness-cancel') {
    runs.get(cmd.id)?.abort();
  } else if (cmd.type === 'remove' && Number.isInteger(cmd.id)) {
    void remove(cmd.runtime, cmd.location).then((ok) => send({ type: 'removed', id: cmd.id, ok }));
  }
});

send({ type: 'ready' });
