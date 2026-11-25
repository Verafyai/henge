import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canRemove, planDownload, type InstalledForDisk } from './disk';
import { estimateFit, fitFromBenchmark, memoryFacts, recommendStarter } from './fit';
import { hardwareFixture as fixtureOrNull } from './fixtures';

const hardwareFixture = (n: string) => fixtureOrNull(n)!;
import { hashFile, hfInstall, ollamaInstall, parseHfRef, parseLlamaBench, ollamaBenchmark } from './sources';

const GB = 1_000_000_000;
const digest = (s: string | Buffer) => `sha256-${createHash('sha256').update(s).digest('hex')}`;

describe('fit estimates (SPEC 5.4)', () => {
  it('uses memory size only, per machine', () => {
    const mac = memoryFacts(hardwareFixture('apple-silicon-32gb'));
    expect(estimateFit(4.7 * GB, mac)).toMatchObject({ status: 'runs_well', basis: 'estimate', reason: 'unified_memory' });
    expect(estimateFit(42.5 * GB, mac)).toMatchObject({ status: 'will_not_fit', reason: 'too_large' });

    const rtx = memoryFacts(hardwareFixture('windows-rtx-12gb'));
    expect(estimateFit(4.7 * GB, rtx)).toMatchObject({ status: 'runs_well', reason: 'gpu_memory' });
    expect(estimateFit(14.3 * GB, rtx)).toMatchObject({ status: 'runs_slowly', reason: 'system_memory_only' });

    const igpu = memoryFacts(hardwareFixture('windows-integrated-only'));
    expect(estimateFit(4.7 * GB, igpu).status).toBe('runs_slowly');
    expect(estimateFit(4.7 * GB, { ramBytes: null, gpuFamily: null, vramBytes: null, unified: false }).status).toBe('unknown');
  });

  it('a benchmark decides only with an approved calibration; otherwise the estimate stands', () => {
    const est = estimateFit(4.7 * GB, memoryFacts(hardwareFixture('windows-rtx-12gb')));
    expect(fitFromBenchmark(3, est, null)).toEqual({ status: 'runs_well', basis: 'estimate', reason: 'benchmark_uncalibrated' });
    const cal = { runtime: 'ollama' as const, catalogVersion: 1, runsWellMinTps: 20, runsSlowlyMinTps: 5 };
    expect(fitFromBenchmark(32, est, cal).status).toBe('runs_well');
    expect(fitFromBenchmark(8, est, cal).status).toBe('runs_slowly');
    expect(fitFromBenchmark(2, est, cal)).toEqual({ status: 'will_not_fit', basis: 'benchmark', reason: 'benchmark' });
  });

  it('recommends the smallest best-fitting model the swarm accepts', () => {
    const mac = memoryFacts(hardwareFixture('apple-silicon-32gb'));
    const c = [
      { slug: 'big', contentHash: 'a', sizeBytes: 42 * GB, acceptedSwarms: ['j'] },
      { slug: 'mid', contentHash: 'b', sizeBytes: 14 * GB, acceptedSwarms: ['j'] },
      { slug: 'small', contentHash: 'c', sizeBytes: 4 * GB, acceptedSwarms: ['other'] },
    ];
    expect(recommendStarter(c, 'j', mac)?.slug).toBe('mid');
    expect(recommendStarter(c, 'nobody', mac)).toBeNull();
  });
});

describe('disk budget (SPEC 5.4)', () => {
  const m = (h: string, size: number, lastUsedAt: number | null, managed = true): InstalledForDisk => ({ contentHash: h, sizeBytes: size * GB, lastUsedAt, installedAt: 1, managed });
  const installed = [m('active', 5, 100), m('old', 5, 10), m('older', 5, 5), m('users-own', 30, 1, false)];

  it('fits, needs a budget, or offers least-used removals', () => {
    expect(planDownload(installed, null, GB, new Set())).toEqual({ ok: false, reason: 'no_budget' });
    expect(planDownload(installed, 20 * GB, 4 * GB, new Set(['active']))).toMatchObject({ ok: true, usedBytes: 15 * GB });
    expect(planDownload(installed, 20 * GB, 21 * GB, new Set())).toMatchObject({ reason: 'larger_than_budget' });
    expect(planDownload(installed, 20 * GB, 8 * GB, new Set(['active']))).toMatchObject({ ok: false, reason: 'over_budget', needBytes: 3 * GB, suggestions: ['older'] });
    expect(planDownload(installed, 20 * GB, 12 * GB, new Set(['active']))).toMatchObject({ suggestions: ['older', 'old'] });
  });

  it('never offers or removes the active model, and never touches models it did not install', () => {
    const plan = planDownload(installed, 10 * GB, 10 * GB, new Set(['active']));
    expect(plan).toMatchObject({ ok: false, reason: 'over_budget', suggestions: [], protectedHashes: ['active'] });
    for (let budget = 5; budget <= 40; budget++) {
      const p = planDownload(installed, budget * GB, 5 * GB, new Set(['active']));
      if (!p.ok && p.reason === 'over_budget') expect(p.suggestions).not.toContain('active');
      if (!p.ok && p.reason === 'over_budget') expect(p.suggestions).not.toContain('users-own');
    }
    expect(canRemove('active', installed, new Set(['active']))).toEqual({ ok: false, reason: 'protected' });
    expect(canRemove('users-own', installed, new Set())).toEqual({ ok: false, reason: 'not_managed' });
    expect(canRemove('old', installed, new Set(['active']))).toEqual({ ok: true });
  });
});

describe('source adapters with hash pinning', () => {
  const good = Buffer.from('pretend gguf bytes');
  const calls: string[] = [];
  const tags: Array<{ name: string; digest: string }> = [{ name: 'mine:latest', digest: 'f'.repeat(64) }];
  let server: Server;
  let base = '';
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'node-core-m2-'));
    server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: tags }));
        if (req.url === '/api/pull') {
          const { model } = JSON.parse(body) as { model: string };
          tags.push({ name: model, digest: model === 'pinned:7b' ? 'a'.repeat(64) : 'b'.repeat(64) });
          res.write('{"status":"pulling manifest"}\n{"status":"downloading","total":100,"completed":50}\n');
          return void res.end('{"status":"success","total":100,"completed":100}\n');
        }
        if (req.url === '/api/delete') {
          const { model } = JSON.parse(body) as { model: string };
          tags.splice(tags.findIndex((t) => t.name === model), 1);
          return void res.end();
        }
        if (req.url === '/api/generate') return void res.end(JSON.stringify({ eval_count: 64, eval_duration: 2e9 }));
        if (req.url === '/org/repo/resolve/main/good.gguf') return void res.end(good);
        if (req.url === '/org/repo/resolve/main/bad.gguf') return void res.end(Buffer.from('tampered'));
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Ollama: a pinned pull verifies; a drifted pull is blocked and removed again', async () => {
    const progress: number[] = [];
    expect(await ollamaInstall(base, 'pinned:7b', `sha256:${'a'.repeat(64)}`, fetch, (c) => progress.push(c))).toEqual({ ok: true, verifiedHash: `sha256-${'a'.repeat(64)}`, managed: true, location: 'pinned:7b' });
    expect(progress).toEqual([50, 100]);
    const drift = await ollamaInstall(base, 'drifty:7b', `sha256-${'a'.repeat(64)}`, fetch);
    expect(drift).toMatchObject({ ok: false, reason: 'hash_mismatch', actual: `sha256-${'b'.repeat(64)}` });
    expect(calls).toContain('DELETE /api/delete');
    expect(tags.map((t) => t.name)).not.toContain('drifty:7b');
  });

  it('Ollama: a tag the user already has is used if pinned and never pulled over if not', async () => {
    calls.length = 0;
    expect(await ollamaInstall(base, 'mine', `sha256-${'f'.repeat(64)}`, fetch)).toMatchObject({ ok: true, managed: false });
    expect(await ollamaInstall(base, 'mine', `sha256-${'a'.repeat(64)}`, fetch)).toMatchObject({ ok: false, reason: 'tag_drift' });
    expect(calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
    expect(await ollamaInstall(base, 'bad ref;rm', `sha256-${'a'.repeat(64)}`, fetch)).toMatchObject({ reason: 'bad_reference' });
  });

  it('Ollama benchmark reads eval timings', async () => {
    expect(await ollamaBenchmark(base, 'pinned:7b', fetch)).toBe(32);
  });

  it('GGUF: verified files land by hash; a mismatch leaves nothing behind', async () => {
    const ok = await hfInstall({ base, ref: 'org/repo@main/good.gguf', expected: digest(good), sizeBytes: 1000, modelsDir: dir }, fetch);
    expect(ok).toMatchObject({ ok: true, managed: true });
    if (ok.ok) expect(await hashFile(ok.location)).toBe(digest(good));
    const before = readdirSync(dir);
    const bad = await hfInstall({ base, ref: 'org/repo@main/bad.gguf', expected: digest(good).replace(/.$/, '0'), sizeBytes: 1000, modelsDir: dir }, fetch);
    expect(bad).toMatchObject({ ok: false, reason: 'hash_mismatch', actual: digest('tampered') });
    expect(readdirSync(dir)).toEqual(before);
    expect(await hfInstall({ base, ref: 'org/repo@main/good.gguf', expected: digest('x'), sizeBytes: 4, modelsDir: dir }, fetch)).toMatchObject({ reason: 'too_large' });
    expect(readdirSync(dir).some((f) => f.endsWith('.partial'))).toBe(false);
    expect(existsSync(path.join(dir, `${digest('x').slice(7)}.gguf`))).toBe(false);
  });

  it('parses GGUF references and llama-bench output strictly', () => {
    expect(parseHfRef('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF@main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf')).toEqual({ repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', revision: 'main', file: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf' });
    for (const bad of ['org/repo@main/../x.gguf', 'org/repo/x.gguf', 'org/repo@main/x.bin', 'https://evil/x@main/a.gguf']) expect(parseHfRef(bad)).toBeNull();
    expect(parseLlamaBench(JSON.stringify([{ n_prompt: 0, n_gen: 64, avg_ts: 41.237 }]))).toBe(41.24);
    expect(parseLlamaBench('not json')).toBeNull();
  });
});
