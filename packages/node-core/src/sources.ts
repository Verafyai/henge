/**
 * Local source adapters (SPEC 5.2, 5.4): Ollama and Hugging Face GGUF for llama.cpp.
 *
 * Every installable artifact is pinned by content hash. For Ollama that is the manifest digest
 * Ollama reports for the tag; for a GGUF file it is the SHA-256 of the file. A mismatch blocks
 * the model: a drifted Ollama tag we pulled is removed again, a GGUF download is deleted before it
 * is ever moved into the models folder. An Ollama tag the user already had is never pulled over.
 *
 * This module touches the network and disk, so it is a separate entry (`./sources`) that only
 * the supervisor loads, never the renderer.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const HF_DEFAULT_BASE = 'https://huggingface.co';
const HEX = /^[a-f0-9]{64}$/;

export type InstallOutcome =
  | { ok: true; verifiedHash: string; managed: boolean; location: string }
  | { ok: false; reason: 'hash_mismatch'; expected: string; actual: string | null; detail: string }
  | { ok: false; reason: 'tag_drift'; expected: string; actual: string; detail: string }
  | { ok: false; reason: 'too_large' | 'runtime_unavailable' | 'download_failed' | 'bad_reference' | 'cancelled'; detail: string };

export type Progress = (completedBytes: number, totalBytes: number | null) => void;

export function normalizeDigest(d: string): string {
  return `sha256-${d.replace(/^sha256[:-]/, '').toLowerCase()}`;
}

const tagsSchema = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string() }).loose()).default([]) });

async function ollamaTags(base: string, fetchFn: typeof fetch) {
  const res = await fetchFn(new URL('/api/tags', base), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`tags ${res.status}`);
  return tagsSchema.parse(await res.json()).models;
}

const sameTag = (name: string, ref: string) => name === ref || name === `${ref}:latest` || `${name}:latest` === ref;

/** Looks for the tag without changing anything: present and pinned, drifted, or absent. */
export async function ollamaLookup(base: string, ref: string, expected: string, fetchFn: typeof fetch): Promise<'match' | 'absent' | { drift: string }> {
  const m = (await ollamaTags(base, fetchFn)).find((t) => sameTag(t.name, ref));
  if (!m) return 'absent';
  const actual = normalizeDigest(m.digest);
  return actual === normalizeDigest(expected) ? 'match' : { drift: actual };
}

const pullLine = z.object({ status: z.string().optional(), error: z.string().optional(), total: z.number().optional(), completed: z.number().optional() }).loose();

/**
 * Installs an Ollama tag pinned to `expected`. The user confirmed the download before this runs
 * (SPEC 5.1 step 2: ask before modifying a runtime).
 */
export async function ollamaInstall(base: string, ref: string, expected: string, fetchFn: typeof fetch, onProgress: Progress = () => {}, signal?: AbortSignal): Promise<InstallOutcome> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}(:[a-zA-Z0-9._-]{1,80})?$/.test(ref)) return { ok: false, reason: 'bad_reference', detail: 'The catalog reference is not a valid Ollama tag.' };
  let before: Awaited<ReturnType<typeof ollamaLookup>>;
  try {
    before = await ollamaLookup(base, ref, expected, fetchFn);
  } catch {
    return { ok: false, reason: 'runtime_unavailable', detail: 'Ollama is not running on this computer.' };
  }
  if (before === 'match') return { ok: true, verifiedHash: normalizeDigest(expected), managed: false, location: ref };
  if (typeof before === 'object') {
    // Pulling would replace the user's own copy of this tag, so we refuse instead.
    return { ok: false, reason: 'tag_drift', expected: normalizeDigest(expected), actual: before.drift, detail: 'Your Ollama already has this tag with different contents. It was left unchanged.' };
  }
  try {
    const res = await fetchFn(new URL('/api/pull', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: ref, stream: true }), signal });
    if (!res.ok || !res.body) return { ok: false, reason: 'download_failed', detail: `Ollama refused the download (${res.status}).` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const p = pullLine.safeParse(JSON.parse(line));
        if (!p.success) continue;
        if (p.data.error) return { ok: false, reason: 'download_failed', detail: p.data.error.slice(0, 200) };
        if (typeof p.data.completed === 'number') onProgress(p.data.completed, p.data.total ?? null);
      }
    }
  } catch (e) {
    return signal?.aborted ? { ok: false, reason: 'cancelled', detail: 'Download cancelled.' } : { ok: false, reason: 'download_failed', detail: e instanceof Error ? e.message.slice(0, 200) : 'Download failed.' };
  }
  const after = await ollamaLookup(base, ref, expected, fetchFn).catch(() => 'absent' as const);
  if (after === 'match') return { ok: true, verifiedHash: normalizeDigest(expected), managed: true, location: ref };
  if (after === 'absent') return { ok: false, reason: 'download_failed', detail: 'Ollama finished, but the model is not listed.' };
  // We pulled this tag, so it is ours to remove again: a drifted artifact must not stay usable.
  await ollamaRemove(base, ref, fetchFn).catch(() => undefined);
  return { ok: false, reason: 'hash_mismatch', expected: normalizeDigest(expected), actual: after.drift, detail: 'The downloaded model does not match the pinned hash, so it was removed.' };
}

export async function ollamaRemove(base: string, ref: string, fetchFn: typeof fetch): Promise<boolean> {
  const res = await fetchFn(new URL('/api/delete', base), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: ref }) });
  return res.ok;
}

const generateSchema = z.object({ eval_count: z.number().int().positive(), eval_duration: z.number().positive() }).loose();
export const BENCHMARK_PROMPT = 'Count from one to twenty in words, separated by commas.';
export const BENCHMARK_TOKENS = 64;

/** A short tokens-per-second benchmark (SPEC 5.1 step 5), from Ollama's own eval timings. */
export async function ollamaBenchmark(base: string, ref: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<number | null> {
  const res = await fetchFn(new URL('/api/generate', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: ref, prompt: BENCHMARK_PROMPT, stream: false, options: { num_predict: BENCHMARK_TOKENS, temperature: 0 } }),
    signal,
  });
  if (!res.ok) return null;
  const g = generateSchema.safeParse(await res.json());
  if (!g.success) return null;
  return Math.round((g.data.eval_count / (g.data.eval_duration / 1e9)) * 100) / 100;
}

/** `owner/repo@revision/path/to/file.gguf` */
export function parseHfRef(ref: string): { repo: string; revision: string; file: string } | null {
  const m = /^([A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,95})@([\w.-]{1,64})\/((?:[\w.-]+\/)*[\w.-]+\.gguf)$/.exec(ref);
  if (!m || ref.includes('..')) return null;
  return { repo: m[1]!, revision: m[2]!, file: m[3]! };
}

export function hfFileName(contentHash: string) {
  return `${normalizeDigest(contentHash).slice('sha256-'.length)}.gguf`;
}

/**
 * Downloads a GGUF file, hashing as it streams. The file lands as `<hash>.gguf.partial` and is
 * renamed only after the hash matches, so an unverified file is never in the models folder.
 */
export async function hfInstall(
  opts: { base: string; ref: string; expected: string; sizeBytes: number; modelsDir: string },
  fetchFn: typeof fetch,
  onProgress: Progress = () => {},
  signal?: AbortSignal,
): Promise<InstallOutcome> {
  const parsed = parseHfRef(opts.ref);
  const expected = normalizeDigest(opts.expected);
  if (!parsed || !HEX.test(expected.slice(7))) return { ok: false, reason: 'bad_reference', detail: 'The catalog reference is not a valid GGUF file.' };
  const url = `${opts.base.replace(/\/$/, '')}/${parsed.repo}/resolve/${encodeURIComponent(parsed.revision)}/${parsed.file.split('/').map(encodeURIComponent).join('/')}`;
  await mkdir(opts.modelsDir, { recursive: true });
  const final = path.join(opts.modelsDir, hfFileName(expected));
  const partial = `${final}.partial`;
  const hash = createHash('sha256');
  let received = 0;
  const fh = await open(partial, 'w', 0o600);
  try {
    const res = await fetchFn(url, { redirect: 'follow', signal });
    if (!res.ok || !res.body) {
      await fh.close();
      await rm(partial, { force: true });
      return { ok: false, reason: 'download_failed', detail: `The download failed (${res.status}).` };
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > opts.sizeBytes) {
        await reader.cancel();
        await fh.close();
        await rm(partial, { force: true });
        return { ok: false, reason: 'too_large', detail: 'The file is larger than the catalog says, so the download was stopped.' };
      }
      hash.update(value);
      await fh.write(value);
      onProgress(received, opts.sizeBytes);
    }
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await rm(partial, { force: true });
    return signal?.aborted ? { ok: false, reason: 'cancelled', detail: 'Download cancelled.' } : { ok: false, reason: 'download_failed', detail: e instanceof Error ? e.message.slice(0, 200) : 'Download failed.' };
  }
  const actual = `sha256-${hash.digest('hex')}`;
  if (actual !== expected) {
    await rm(partial, { force: true });
    return { ok: false, reason: 'hash_mismatch', expected, actual, detail: 'The downloaded file does not match the pinned hash, so it was deleted.' };
  }
  await rename(partial, final);
  return { ok: true, verifiedHash: expected, managed: true, location: final };
}

/** Re-hashes a file on disk; used before first use and whenever the file may have changed. */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(`sha256-${h.digest('hex')}`));
  });
}

const llamaBenchSchema = z.array(z.object({ n_prompt: z.number(), n_gen: z.number(), avg_ts: z.number() }).loose());

/** Parses `llama-bench -o json` output; returns generation tokens per second. */
export function parseLlamaBench(stdout: string): number | null {
  try {
    const rows = llamaBenchSchema.parse(JSON.parse(stdout));
    const gen = rows.find((r) => r.n_gen > 0 && r.n_prompt === 0) ?? rows.find((r) => r.n_gen > 0);
    return gen && gen.avg_ts > 0 ? Math.round(gen.avg_ts * 100) / 100 : null;
  } catch {
    return null;
  }
}

export const LLAMA_BENCH_ARGS = (modelPath: string) => ['-m', modelPath, '-p', '0', '-n', String(BENCHMARK_TOKENS), '-o', 'json'];
