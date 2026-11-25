import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintCapability, newCapabilityKey } from './capability';
import { ModelProxy, proxyComplete } from './proxy';
import { LlamaServerSource, ollamaSource, SourceError, type CompletionSource, type SpawnFn } from './sources';

const H = (c: string) => `sha256-${c.repeat(64)}`;
const ask = { messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 16 };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const dir = mkdtempSync(path.join(tmpdir(), 'se-sources-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fetch that never answers until aborted, like a model still generating. */
function hangingFetch(seen: { aborted: boolean }) {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        seen.aborted = true;
        reject(new Error('aborted'));
      });
    })) as typeof fetch;
}

describe('Ollama source', () => {
  it('maps the request to /api/chat and caps the reported output', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const f = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return json({ message: { content: 'ok' }, prompt_eval_count: 7 });
    }) as typeof fetch;
    const r = await ollamaSource('http://127.0.0.1:11434', f).complete({ contentHash: H('a'), runtime: 'ollama', ref: 'tag:1' }, ask, new AbortController().signal);
    expect(r).toEqual({ content: 'ok', usage: { input_tokens: 7, output_tokens: 16 }, cost_usd_micros: 0 });
    expect(calls[0]).toEqual({ url: 'http://127.0.0.1:11434/api/chat', body: { model: 'tag:1', messages: ask.messages, stream: false, options: { num_predict: 16 } } });
  });

  it('cancels a running generation when aborted', async () => {
    const seen = { aborted: false };
    const ctl = new AbortController();
    const p = ollamaSource('http://127.0.0.1:11434', hangingFetch(seen)).complete({ contentHash: H('a'), runtime: 'ollama', ref: 't' }, ask, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen.aborted).toBe(true);
  });
});

describe('llama.cpp source (llama-server)', () => {
  function fakes() {
    const spawned: Array<{ cmd: string; args: string[]; env: Record<string, string>; killed: boolean; exit?: () => void }> = [];
    const spawn: SpawnFn = (cmd, args, opts) => {
      const rec: (typeof spawned)[number] = { cmd, args, env: opts.env, killed: false };
      spawned.push(rec);
      return {
        kill: () => {
          rec.killed = true;
          rec.exit?.();
          return true;
        },
        once: (_ev, cb) => {
          rec.exit = () => cb(0);
        },
      };
    };
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    let healthFails = 1;
    const f = (async (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith('/health')) return healthFails-- > 0 ? json({ status: 'loading' }, 503) : json({ status: 'ok' });
      return json({ choices: [{ message: { content: '{"reproduced":false}' } }], usage: { prompt_tokens: 30, completion_tokens: 9 } });
    }) as typeof fetch;
    let port = 41000;
    return { spawn, f, calls, spawned, freePort: async () => port++ };
  }

  it('starts llama-server for the file on loopback with a key in its environment, then completes', async () => {
    const k = fakes();
    const src = new LlamaServerSource({ binary: '/opt/bin/llama-server', spawn: k.spawn, fetch: k.f, freePort: k.freePort, pollMs: 1 });
    const model = { contentHash: H('b'), runtime: 'llama_cpp' as const, ref: 'x', path: '/models/a.gguf' };
    const r = await src.complete(model, ask, new AbortController().signal);
    expect(r).toEqual({ content: '{"reproduced":false}', usage: { input_tokens: 30, output_tokens: 9 }, cost_usd_micros: 0 });
    expect(k.spawned).toHaveLength(1);
    expect(k.spawned[0]).toMatchObject({ cmd: '/opt/bin/llama-server', args: ['-m', '/models/a.gguf', '--host', '127.0.0.1', '--port', '41000'] });
    const key = k.spawned[0]!.env['LLAMA_API_KEY']!;
    expect(key.length).toBeGreaterThan(20);
    expect(k.spawned[0]!.args.join(' ')).not.toContain(key);
    const chat = k.calls.find((c) => c.url.endsWith('/v1/chat/completions'))!;
    expect(chat).toMatchObject({ url: 'http://127.0.0.1:41000/v1/chat/completions', auth: `Bearer ${key}`, body: { messages: ask.messages, max_tokens: 16, stream: false } });
    // The same file reuses the running server; another file replaces it (one model at a time).
    await src.complete(model, ask, new AbortController().signal);
    expect(k.spawned).toHaveLength(1);
    await src.complete({ ...model, path: '/models/b.gguf' }, ask, new AbortController().signal);
    expect(k.spawned).toHaveLength(2);
    expect(k.spawned[0]!.killed).toBe(true);
    await src.stop();
    expect(k.spawned[1]!.killed).toBe(true);
  });

  it('reports the runtime unavailable when llama-server exits before it is ready', async () => {
    const spawn: SpawnFn = () => ({ kill: () => true, once: (_ev, cb) => setTimeout(() => cb(1), 1) });
    const f = (async () => {
      throw new Error('refused');
    }) as typeof fetch;
    const src = new LlamaServerSource({ binary: '/x/llama-server', spawn, fetch: f, freePort: async () => 1, pollMs: 2, startTimeoutMs: 1000 });
    await expect(src.complete({ contentHash: H('c'), runtime: 'llama_cpp', ref: 'x', path: '/m.gguf' }, ask, new AbortController().signal)).rejects.toBeInstanceOf(SourceError);
  });
});

describe('model proxy routing and cancellation', () => {
  it('serves GGUF models through the llama.cpp source and cancels the runtime call when the caller hangs up', async () => {
    const key = newCapabilityKey();
    const sock = path.join(dir, 'p.sock');
    const gguf = path.join(dir, 'm.gguf');
    writeFileSync(gguf, 'gguf bytes');
    const hash = `sha256-${createHash('sha256').update('gguf bytes').digest('hex')}`;
    let aborted = false;
    let release: (() => void) | null = null;
    const llama: CompletionSource = {
      complete: (_m, req, signal) =>
        new Promise((resolve, reject) => {
          release = () => resolve({ content: 'from llama', usage: { input_tokens: 1, output_tokens: Math.min(3, req.max_tokens) }, cost_usd_micros: 0 });
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new SourceError('cancelled'));
          });
        }),
    };
    const proxy = new ModelProxy({ key, socketPath: sock, ollamaBase: null, sources: { llama_cpp: llama } });
    await proxy.start();
    expect(await proxy.setModels([{ contentHash: hash, runtime: 'llama_cpp', ref: 'x', path: gguf }])).toEqual({ refused: [] });
    const cap = mintCapability(key, { lease: 'l', model: hash, model_class: 'c', max_tokens: 100, max_cost_usd_micros: 0, permissions_hash: H('d') }, 60_000);

    const first = proxyComplete(sock, cap, ask);
    await expect.poll(() => release !== null).toBe(true);
    release!();
    expect(await first).toMatchObject({ status: 200, body: { content: 'from llama' } });

    release = null;
    const ctl = new AbortController();
    const second = proxyComplete(sock, cap, ask, ctl.signal);
    await expect.poll(() => release !== null).toBe(true);
    ctl.abort();
    await expect(second).rejects.toThrow('cancelled');
    await expect.poll(() => aborted).toBe(true);
    await expect.poll(() => proxy.inFlight).toBe(0);
    await proxy.stop();
  });
});
