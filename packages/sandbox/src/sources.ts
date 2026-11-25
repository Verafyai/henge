/**
 * Local model sources behind the proxy (SPEC 5.2, 11.1). Ollama first, then llama.cpp's
 * `llama-server` as a second source behind the same interface (decision 2026-11-25: llama.cpp
 * serving lands in M5). Every call takes an AbortSignal, so Pause and leave cancel a running
 * generation: the runtime sees the connection close and stops.
 *
 * Both runtimes are reached only on loopback. `llama-server` is started by the proxy for one GGUF
 * file at a time (local GPU concurrency is one), bound to 127.0.0.1 on a free port, and protected by
 * a random API key passed through its environment, never on the command line.
 */
import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';
import { z } from 'zod';
import type { CompleteRequest, CompleteResponse, ProxyModel } from './proxy';

export interface CompletionSource {
  complete(model: ProxyModel, req: CompleteRequest, signal: AbortSignal): Promise<CompleteResponse>;
  stop?(): Promise<void>;
}

export class SourceError extends Error {
  constructor(readonly code: 'runtime_unavailable' | 'runtime_error' | 'cancelled') {
    super(code);
  }
}

const ollamaChatSchema = z.object({ message: z.object({ content: z.string() }), eval_count: z.number().int().optional(), prompt_eval_count: z.number().int().optional() }).loose();

/** Ollama's /api/chat. The output count is capped at the request's max_tokens if it is missing. */
export function ollamaSource(base: string, f: typeof fetch = fetch): CompletionSource {
  return {
    async complete(model, req, signal) {
      let r: Response;
      try {
        r = await f(new URL('/api/chat', base), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: model.ref, messages: req.messages, stream: false, options: { num_predict: req.max_tokens } }),
          signal,
        });
      } catch {
        throw new SourceError(signal.aborted ? 'cancelled' : 'runtime_error');
      }
      const j = ollamaChatSchema.safeParse(await r.json().catch(() => null));
      if (!r.ok || !j.success) throw new SourceError('runtime_error');
      const output = Math.min(j.data.eval_count ?? req.max_tokens, req.max_tokens);
      return { content: j.data.message.content, usage: { input_tokens: j.data.prompt_eval_count ?? 0, output_tokens: output }, cost_usd_micros: 0 };
    },
  };
}

const chatCompletionSchema = z
  .object({
    choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }).loose() }).loose()).min(1),
    usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional() }).loose().optional(),
  })
  .loose();

type Child = { pid?: number | undefined; kill(signal?: NodeJS.Signals): boolean; once(ev: 'exit', cb: (code: number | null) => void): unknown };
export type SpawnFn = (cmd: string, args: string[], opts: { env: Record<string, string>; stdio: 'ignore' }) => Child;

/** A free loopback TCP port. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * `llama-server` for GGUF models. Started lazily for the first call to a file and kept for the next
 * call to the same file; a call for another file stops it and starts that one.
 */
export class LlamaServerSource implements CompletionSource {
  private current: { path: string; base: string; child: Child; ready: Promise<void>; exited: boolean } | null = null;
  private readonly key = randomBytes(24).toString('base64url');

  constructor(
    private o: {
      /** Absolute path of `llama-server`, resolved by the main process from PATH. */
      binary: string;
      spawn?: SpawnFn;
      fetch?: typeof fetch;
      freePort?: () => Promise<number>;
      /** Engineering limit on how long a model may take to load before the call fails. */
      startTimeoutMs?: number;
      pollMs?: number;
    },
  ) {}

  private get fetch() {
    return this.o.fetch ?? fetch;
  }

  private async ensure(path: string): Promise<string> {
    if (this.current && this.current.path === path && !this.current.exited) {
      await this.current.ready;
      return this.current.base;
    }
    await this.stop();
    const port = await (this.o.freePort ?? freeLoopbackPort)();
    const spawn = this.o.spawn ?? (nodeSpawn as unknown as SpawnFn);
    // The API key goes through the environment so it never shows in a process list.
    const child = spawn(this.o.binary, ['-m', path, '--host', '127.0.0.1', '--port', String(port)], { env: { LLAMA_API_KEY: this.key, PATH: '' }, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    const cur = { path, base, child, exited: false, ready: Promise.resolve() };
    child.once('exit', () => {
      cur.exited = true;
    });
    cur.ready = this.waitReady(cur);
    this.current = cur;
    try {
      await cur.ready;
    } catch (e) {
      await this.stop();
      throw e;
    }
    return base;
  }

  private async waitReady(cur: { base: string; exited: boolean }) {
    const deadline = Date.now() + (this.o.startTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (cur.exited) throw new SourceError('runtime_unavailable');
      try {
        const r = await this.fetch(new URL('/health', cur.base), { headers: { authorization: `Bearer ${this.key}` } });
        if (r.ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 250));
    }
    throw new SourceError('runtime_unavailable');
  }

  async complete(model: ProxyModel, req: CompleteRequest, signal: AbortSignal): Promise<CompleteResponse> {
    if (!model.path) throw new SourceError('runtime_unavailable');
    const base = await this.ensure(model.path);
    let r: Response;
    try {
      r = await this.fetch(new URL('/v1/chat/completions', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ messages: req.messages, max_tokens: req.max_tokens, stream: false }),
        signal,
      });
    } catch {
      throw new SourceError(signal.aborted ? 'cancelled' : 'runtime_error');
    }
    const j = chatCompletionSchema.safeParse(await r.json().catch(() => null));
    if (!r.ok || !j.success) throw new SourceError('runtime_error');
    const output = Math.min(j.data.usage?.completion_tokens ?? req.max_tokens, req.max_tokens);
    return { content: j.data.choices[0]!.message.content ?? '', usage: { input_tokens: j.data.usage?.prompt_tokens ?? 0, output_tokens: output }, cost_usd_micros: 0 };
  }

  async stop() {
    const cur = this.current;
    this.current = null;
    if (cur && !cur.exited) cur.child.kill('SIGTERM');
  }
}
