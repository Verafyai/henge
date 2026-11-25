/**
 * Sandbox broker (SPEC 11.1, 11.3, 11.5). Runs one verified wasm harness for one task.
 *
 * Isolation: the module runs in a worker thread with an empty environment and V8 heap limits. It
 * gets one host-created memory with a hard maximum, and only the host functions its granted
 * capabilities link. There is no filesystem, socket, clock, environment or process access to
 * import. Wall time and step count end the task when exceeded; the worker is terminated, even
 * inside a tight loop.
 *
 * Host calls are synchronous for the harness (Atomics.wait on a shared buffer) while the broker
 * services them asynchronously: model completions through the capability-scoped proxy, network
 * through the egress policy, scratch through the size-capped folder.
 *
 * Prompt injection (SPEC 11.5): the system prompt always comes from the signed bundle; a harness
 * cannot send its own system message. Task input is screened before any model use and the verdict
 * recorded. Output must be JSON matching the bundle's output schema, or the result is rejected.
 */
import { Worker } from 'node:worker_threads';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import type { VerifiedBundle } from './bundle';
import { EgressError, type EgressRequest, type EgressResponse } from './egress';
import type { CompleteRequest, CompleteResponse } from './proxy';
import { ScratchError, type Scratch } from './scratch';
import { checkHarnessModule, type Capability, type HostFunction } from './wasm-validate';

const WASM_PAGE = 64 * 1024;
const RESPONSE_CAP = 1024 * 1024;

export type ScreenVerdict = { verdict: 'allow' | 'flag'; reasons: string[]; screener: string };
export type Screener = (input: unknown) => Promise<ScreenVerdict> | ScreenVerdict;

export type RunLimits = { memoryMb: number; wallMs: number; maxModelCalls: number; maxTokensPerCall: number };

export type HostServices = {
  complete: ((req: CompleteRequest) => Promise<{ ok: true; response: CompleteResponse } | { ok: false; error: string }>) | null;
  fetch: ((req: EgressRequest) => Promise<EgressResponse>) | null;
  scratch: Scratch | null;
  screen: Screener;
};

export type RunEvent = { at: number; kind: string; detail: string };

export type RunResult =
  | { status: 'ok'; output: unknown; screen: ScreenVerdict; events: RunEvent[]; modelCalls: number }
  | { status: 'refused'; reason: string; events: RunEvent[] }
  | { status: 'limit_exceeded'; limit: 'wall_time' | 'memory' | 'model_calls' | 'heap'; screen: ScreenVerdict; events: RunEvent[] }
  | { status: 'failed'; reason: string; screen: ScreenVerdict; events: RunEvent[] }
  | { status: 'invalid_output'; reason: string; screen: ScreenVerdict; events: RunEvent[] };

/** Capabilities a run may use: what the bundle declares, narrowed by what the user approved. */
export function grantedCapabilities(declared: readonly string[], permissions: { networkDomains: readonly string[]; scratchBytes: number }): Set<Capability> {
  const g = new Set<Capability>();
  if (declared.includes('model.complete')) g.add('model.complete');
  if (declared.includes('network.fetch') && permissions.networkDomains.length > 0) g.add('network.fetch');
  if (permissions.scratchBytes > 0) {
    if (declared.includes('scratch.read')) g.add('scratch.read');
    if (declared.includes('scratch.write')) g.add('scratch.write');
  }
  return g;
}

/** Runs inside the worker. Plain JavaScript: it is evaluated as the worker's source. */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { wasm, input, maxPages, imports: linked, sab } = workerData;
const ctl = new Int32Array(sab, 0, 2);
const data = new Uint8Array(sab, 8);
const enc = new TextEncoder();
const dec = new TextDecoder();
const memory = new WebAssembly.Memory({ initial: 1, maximum: maxPages });
let instance;
const view = () => new Uint8Array(memory.buffer);
const readStr = (ptr, len) => {
  if (ptr < 0 || len < 0 || ptr + len > memory.buffer.byteLength) throw new Error('out of bounds');
  return dec.decode(view().slice(ptr, ptr + len));
};
const writeStr = (s) => {
  const b = enc.encode(s);
  const ptr = instance.exports.alloc(b.length) >>> 0;
  if (ptr + b.length > memory.buffer.byteLength) throw new Error('alloc out of bounds');
  view().set(b, ptr);
  return (BigInt(ptr) << 32n) | BigInt(b.length);
};
const call = (name) => (ptr, len) => {
  const req = readStr(ptr, len);
  Atomics.store(ctl, 0, 0);
  parentPort.postMessage({ t: 'call', name, req });
  Atomics.wait(ctl, 0, 0);
  const n = Atomics.load(ctl, 1);
  return writeStr(dec.decode(data.slice(0, n)));
};
const host = { memory };
for (const name of linked) host[name] = name === 'log' ? (ptr, len) => { parentPort.postMessage({ t: 'log', msg: readStr(ptr, Math.min(len, 2000)) }); return 0n; } : call(name);
try {
  instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), { swarm: host });
  const inp = writeStr(input);
  const out = instance.exports.run(Number(inp >> 32n), Number(inp & 0xffffffffn));
  parentPort.postMessage({ t: 'done', output: readStr(Number(out >> 32n), Number(out & 0xffffffffn)) });
} catch (e) {
  parentPort.postMessage({ t: 'error', message: String(e && e.message || e).slice(0, 300), oom: memory.buffer.byteLength >= maxPages * 65536 });
}
`;

const harnessCompleteSchema = z
  .object({
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(200_000) }).strict()).min(1).max(63),
    max_tokens: z.number().int().positive(),
  })
  .strict();

/** Runs one task. Aborting `signal` (Leave, Pause) terminates the worker at once and reports `cancelled`. */
export async function runHarness(o: { bundle: VerifiedBundle; input: unknown; granted: ReadonlySet<Capability>; limits: RunLimits; host: HostServices; now?: () => number; signal?: AbortSignal }): Promise<RunResult> {
  const events: RunEvent[] = [];
  const now = o.now ?? Date.now;
  const ev = (kind: string, detail: string) => events.push({ at: now(), kind, detail: detail.slice(0, 300) });

  if (o.bundle.harness.runtime !== 'wasm' || !o.bundle.wasm) {
    // Container harnesses need a VM-backed isolation boundary that this build does not ship.
    return { status: 'refused', reason: 'container_isolation_unavailable', events };
  }
  const check = checkHarnessModule(o.bundle.wasm, o.granted);
  if (!check.ok) return { status: 'refused', reason: check.reason, events };

  // Screen task input before any model use (SPEC 11.5) and record the verdict.
  const screen = await o.host.screen(o.input);
  ev('screen', `${screen.screener}: ${screen.verdict}${screen.reasons.length ? ` (${screen.reasons.join(', ')})` : ''}`);

  const maxPages = Math.max(1, Math.floor((o.limits.memoryMb * 1024 * 1024) / WASM_PAGE));
  const sab = new SharedArrayBuffer(8 + RESPONSE_CAP);
  const ctl = new Int32Array(sab, 0, 2);
  const data = new Uint8Array(sab, 8);
  let modelCalls = 0;

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { wasm: o.bundle.wasm, input: JSON.stringify({ task: o.input }), maxPages, imports: check.imports, sab },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => {
      ev('limit', `wall time ${o.limits.wallMs} ms`);
      finish({ status: 'limit_exceeded', limit: 'wall_time', screen, events });
    }, o.limits.wallMs);
    const onAbort = () => {
      ev('cancel', 'stopped by the node');
      finish({ status: 'failed', reason: 'cancelled', screen, events });
    };
    if (o.signal?.aborted) onAbort();
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const reply = (body: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      const n = bytes.length > RESPONSE_CAP ? new TextEncoder().encode('{"ok":false,"error":"response_too_large"}') : bytes;
      data.set(n);
      Atomics.store(ctl, 1, n.length);
      Atomics.store(ctl, 0, 1);
      Atomics.notify(ctl, 0);
    };

    const serve = async (name: HostFunction, req: string): Promise<unknown> => {
      let j: unknown;
      try {
        j = JSON.parse(req);
      } catch {
        return { ok: false, error: 'invalid_json' };
      }
      if (name === 'model_complete') {
        if (!o.host.complete) return { ok: false, error: 'model_unavailable' };
        if (++modelCalls > o.limits.maxModelCalls) {
          ev('limit', `model calls over ${o.limits.maxModelCalls}`);
          finish({ status: 'limit_exceeded', limit: 'model_calls', screen, events });
          return { ok: false, error: 'step_limit' };
        }
        const p = harnessCompleteSchema.safeParse(j);
        if (!p.success) {
          ev('model', 'refused: harness may send only user and assistant messages');
          return { ok: false, error: 'invalid_request' };
        }
        // The signed bundle's system prompt is the only system message, always first.
        const r = await o.host.complete({ messages: [{ role: 'system', content: o.bundle.systemPrompt }, ...p.data.messages], max_tokens: Math.min(p.data.max_tokens, o.limits.maxTokensPerCall) });
        ev('model', r.ok ? `ok, ${r.response.usage.output_tokens} tokens` : `refused: ${r.error}`);
        return r.ok ? { ok: true, content: r.response.content } : { ok: false, error: r.error };
      }
      if (name === 'net_fetch') {
        if (!o.host.fetch) return { ok: false, error: 'network_denied' };
        const p = z.object({ url: z.string().max(2048), method: z.enum(['GET', 'POST']).optional(), body: z.string().max(65536).optional() }).strict().safeParse(j);
        if (!p.success) return { ok: false, error: 'invalid_request' };
        try {
          const r = await o.host.fetch(p.data);
          ev('network', `${r.status} ${new URL(r.finalUrl).hostname}`);
          return { ok: true, status: r.status, body: r.body.slice(0, RESPONSE_CAP / 2) };
        } catch (e) {
          const code = e instanceof EgressError ? e.code : 'network_error';
          ev('network', `denied: ${code}`);
          return { ok: false, error: code };
        }
      }
      if (name === 'scratch_write' || name === 'scratch_read') {
        if (!o.host.scratch) return { ok: false, error: 'scratch_disabled' };
        const p = z.object({ name: z.string().max(100), data: z.string().max(RESPONSE_CAP / 2).optional() }).strict().safeParse(j);
        if (!p.success) return { ok: false, error: 'invalid_request' };
        try {
          if (name === 'scratch_write') {
            await o.host.scratch.write(p.data.name, Buffer.from(p.data.data ?? '', 'utf8'));
            return { ok: true };
          }
          return { ok: true, data: (await o.host.scratch.read(p.data.name)).toString('utf8') };
        } catch (e) {
          const code = e instanceof ScratchError ? e.code : 'scratch_error';
          ev('scratch', `denied: ${code}`);
          return { ok: false, error: code };
        }
      }
      return { ok: false, error: 'unknown_host_function' };
    };

    worker.on('message', (m: { t: string; name?: HostFunction; req?: string; msg?: string; output?: string; message?: string; oom?: boolean }) => {
      if (m.t === 'call') void serve(m.name!, m.req!).then(reply, () => reply({ ok: false, error: 'host_error' }));
      else if (m.t === 'log') ev('log', m.msg ?? '');
      else if (m.t === 'error') {
        if (m.oom) {
          ev('limit', 'memory');
          finish({ status: 'limit_exceeded', limit: 'memory', screen, events });
        } else finish({ status: 'failed', reason: m.message ?? 'trap', screen, events });
      } else if (m.t === 'done') {
        let output: unknown;
        try {
          output = JSON.parse(m.output ?? '');
        } catch {
          return finish({ status: 'invalid_output', reason: 'output is not JSON', screen, events });
        }
        const ajv = new Ajv2020({ strict: false, allErrors: true });
        const validate = ajv.compile(o.bundle.outputSchema as object);
        if (!validate(output)) return finish({ status: 'invalid_output', reason: ajv.errorsText(validate.errors).slice(0, 300), screen, events });
        finish({ status: 'ok', output, screen, events, modelCalls });
      }
    });
    worker.on('error', (e) => {
      const heap = /heap|memory/i.test(String(e));
      ev(heap ? 'limit' : 'error', String(e).slice(0, 200));
      finish(heap ? { status: 'limit_exceeded', limit: 'heap', screen, events } : { status: 'failed', reason: 'worker error', screen, events });
    });
    worker.on('exit', () => finish({ status: 'failed', reason: 'harness exited without a result', screen, events }));
  });
}

/**
 * Stand-in screener until the Prompt Guard model runs as a host capability: flags common
 * instruction-override and secret-extraction phrasing. Flagged input still runs, because the
 * structural protections above do not depend on the screen; the verdict is recorded.
 */
export const heuristicScreener: Screener = (input) => {
  const text = JSON.stringify(input).toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ['instruction_override', /ignore (all |any )?(previous|prior|above) (instructions|rules)|disregard (the )?(system|previous)/],
    ['secret_extraction', /api[_ ]?key|private key|keychain|password|secret token|\.ssh|env(ironment)? variables?/],
    ['policy_change', /change (your|the) (policy|permissions|rules)|grant (yourself|me) (access|permission)|new system prompt/],
    ['schema_change', /(change|alter|ignore) (the )?(output|result) (schema|format)/],
  ];
  const reasons = rules.filter(([, re]) => re.test(text)).map(([k]) => k);
  return { verdict: reasons.length ? 'flag' : 'allow', reasons, screener: 'heuristic-v1' };
};
