/**
 * Node supervisor (SPEC 11.1, 11.2): a separate Electron utility process. It detects hardware and
 * runtimes, owns the pause state, and (M2) downloads, verifies, benchmarks and removes models;
 * scheduling and leases arrive in M5. It never imports the
 * keychain module and never sees tokens or keys: the main process makes every authenticated call.
 */
import { execFile } from 'node:child_process';
import { access, constants, rm } from 'node:fs/promises';
import path from 'node:path';
import { discoverLlamaCpp, discoverOllama, hardwareFixture, ollamaBaseUrl } from '@swarm-explorer/node-core';
import { detectHardware, systemProbeDeps } from '@swarm-explorer/node-core/probe';
import { HF_DEFAULT_BASE, LLAMA_BENCH_ARGS, hfInstall, ollamaBenchmark, ollamaInstall, ollamaRemove, parseLlamaBench } from '@swarm-explorer/node-core/sources';
import { mintCapability, proxyComplete, runSandboxChecks } from '@swarm-explorer/sandbox';
import type { Detection, SandboxCheck, SupervisorCommand, SupervisorMessage } from '../shared/node';

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
    // Nothing runs yet; when leases exist (M5), pause abandons them immediately (SPEC 5.2, 7).
    paused = cmd.type === 'pause';
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
  } else if (cmd.type === 'remove' && Number.isInteger(cmd.id)) {
    void remove(cmd.runtime, cmd.location).then((ok) => send({ type: 'removed', id: cmd.id, ok }));
  }
});

send({ type: 'ready' });
