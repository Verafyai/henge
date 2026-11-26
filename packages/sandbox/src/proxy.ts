/**
 * Local model proxy (SPEC 11.1, 11.2). The only way a harness reaches a model:
 *
 * - listens on a Unix socket (named pipe on Windows) in a private folder, never on a TCP port;
 * - every request carries a capability token scoped to one lease, model, token cap and cost cap;
 * - exposes one route, `POST /v1/complete`; runtime administration (pull, delete, load) is never
 *   reachable through it;
 * - the harness never learns the runtime address, the model tag or any credential;
 * - if the caller goes away (Pause, leave, a rule stop), the runtime call is cancelled.
 *
 * Sources: Ollama, and llama.cpp's `llama-server` for GGUF files (sources.ts).
 * API providers (keychain access) are off until the provider terms review (SPEC 5.5).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import http from 'node:http';
import { z } from 'zod';
import { verifyCapability } from './capability';
import { LlamaServerSource, ollamaSource, SourceError, type CompletionSource } from './sources';

export type ProxyModel = { contentHash: string; runtime: 'ollama' | 'llama_cpp'; ref: string; path?: string };

export const completeRequestSchema = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(200_000) }).strict())
      .min(1)
      .max(64),
    max_tokens: z.number().int().positive().max(100_000),
  })
  .strict();
export type CompleteRequest = z.infer<typeof completeRequestSchema>;

export const completeResponseSchema = z.object({
  content: z.string(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
  cost_usd_micros: z.number().int().nonnegative(),
});
export type CompleteResponse = z.infer<typeof completeResponseSchema>;

const MAX_BODY = 1024 * 1024;

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(`sha256-${h.digest('hex')}`));
  });
}

export class ModelProxy {
  private server: http.Server | null = null;
  private models = new Map<string, ProxyModel>();
  private used = new Map<string, number>();
  /** Calls the proxy made, for tests and the self-check; never contains prompts. */
  readonly audit: Array<{ capability: string; model: string; outcome: string }> = [];

  private readonly sources: Partial<Record<ProxyModel['runtime'], CompletionSource>>;

  constructor(
    private opts: {
      key: Buffer;
      socketPath: string;
      ollamaBase: string | null;
      /** Absolute path of `llama-server`, or null when llama.cpp is not installed. */
      llamaServer?: string | null;
      fetch?: typeof fetch;
      now?: () => number;
      /** Tests replace the runtimes. */
      sources?: Partial<Record<ProxyModel['runtime'], CompletionSource>>;
    },
  ) {
    this.sources = {
      ...(opts.ollamaBase ? { ollama: ollamaSource(opts.ollamaBase, opts.fetch) } : {}),
      ...(opts.llamaServer ? { llama_cpp: new LlamaServerSource({ binary: opts.llamaServer, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) } : {}),
      ...opts.sources,
    };
  }

  /** Calls in flight, for tests and the self-check. */
  inFlight = 0;

  /** Registers installed models. GGUF files are re-hashed before first use (SPEC 5.4). */
  async setModels(list: readonly ProxyModel[]): Promise<{ refused: string[] }> {
    const next = new Map<string, ProxyModel>();
    const refused: string[] = [];
    for (const m of list) {
      if (m.runtime === 'llama_cpp') {
        const actual = m.path ? await hashFile(m.path).catch(() => null) : null;
        if (actual !== m.contentHash) {
          refused.push(m.contentHash);
          continue;
        }
      }
      next.set(m.contentHash, m);
    }
    this.models = next;
    return { refused };
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32') await rm(this.opts.socketPath, { force: true });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.socketPath, () => resolve());
    });
    if (process.platform !== 'win32') await chmod(this.opts.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    for (const s of Object.values(this.sources)) await s.stop?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    if (process.platform !== 'win32') await rm(this.opts.socketPath, { force: true });
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST' || req.url !== '/v1/complete') return this.send(res, 404, { error: 'not_found' });
    const auth = /^Bearer (\S+)$/.exec(req.headers['authorization'] ?? '');
    const cap = auth ? verifyCapability(this.opts.key, auth[1]!, this.opts.now?.()) : ({ ok: false, reason: 'malformed' } as const);
    if (!cap.ok) return this.send(res, 401, { error: `capability_${cap.reason}` });
    const c = cap.claims;
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return this.send(res, 413, { error: 'body_too_large' });
    }
    let parsed: z.ZodSafeParseResult<CompleteRequest>;
    try {
      parsed = completeRequestSchema.safeParse(JSON.parse(raw));
    } catch {
      return this.send(res, 400, { error: 'invalid_body' });
    }
    if (!parsed.success) return this.send(res, 400, { error: 'invalid_body' });
    const used = this.used.get(c.id) ?? 0;
    if (parsed.data.max_tokens > c.max_tokens - used) {
      this.audit.push({ capability: c.id, model: c.model, outcome: 'token_cap' });
      return this.send(res, 429, { error: 'token_cap_exceeded' });
    }
    const model = this.models.get(c.model);
    if (!model) return this.send(res, 409, { error: 'model_not_available' });
    const source = this.sources[model.runtime];
    if (!source) return this.send(res, 503, { error: 'runtime_unavailable' });
    // The caller hanging up (the sandbox was stopped) cancels the generation in the runtime.
    const ctl = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ctl.abort();
    });
    let out: CompleteResponse;
    this.inFlight++;
    try {
      out = await source.complete(model, parsed.data, ctl.signal);
    } catch (e) {
      const code = e instanceof SourceError ? e.code : 'runtime_error';
      this.audit.push({ capability: c.id, model: c.model, outcome: code });
      return ctl.signal.aborted ? undefined : this.send(res, code === 'runtime_unavailable' ? 503 : 502, { error: code });
    } finally {
      this.inFlight--;
    }
    // Count the whole request's cap as spent if the runtime did not report usage.
    this.used.set(c.id, used + out.usage.output_tokens);
    this.audit.push({ capability: c.id, model: c.model, outcome: 'ok' });
    this.send(res, 200, out);
  }
}

/** Client side, used by the sandbox broker. Aborting `signal` hangs up, which cancels the runtime call. */
export function proxyComplete(socketPath: string, token: string, body: CompleteRequest, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const data = JSON.stringify(body);
    const req = http.request({ socketPath, path: '/v1/complete', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: null });
        }
      });
    });
    req.on('error', reject);
    signal?.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
    req.end(data);
  });
}
