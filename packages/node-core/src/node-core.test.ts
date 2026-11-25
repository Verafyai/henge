import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  causeFit,
  DEFAULT_RUN_RULES,
  describeRunRules,
  discoverLlamaCpp,
  discoverOllama,
  enforcementSupport,
  HARDWARE_FIXTURE_NAMES,
  hardwareFixture,
  minimizeCapabilities,
  ollamaBaseUrl,
  parseNvidiaSmi,
  parseSystemProfilerDisplays,
  parseWinVideoControllers,
  recommendMode,
  type HardwareReport,
} from './index';
import { detectHardware, type ProbeDeps } from './probe';

const P = (f: string) => readFileSync(path.join(import.meta.dirname, '../fixtures/probes', f), 'utf8');
const GIB = 1024 ** 3;
const fx = (n: string) => hardwareFixture(n) as HardwareReport;
const SMALLEST_CATALOG_ARTIFACT = 4_700_000_000;

describe('probe parsers', () => {
  it('reads Apple Silicon as unified memory with no VRAM guess', () => {
    expect(parseSystemProfilerDisplays(JSON.parse(P('system-profiler-apple.json')))).toEqual([
      { vendor: 'apple', name: 'Apple M3 Pro', vramBytes: null, memory: 'unified', vramConfidence: 'unknown' },
    ]);
  });
  it('reads Intel Mac shared and dedicated memory', () => {
    const g = parseSystemProfilerDisplays(JSON.parse(P('system-profiler-intel-mac.json')));
    expect(g.map((x) => [x.vendor, x.memory, x.vramBytes])).toEqual([
      ['intel', 'shared', 1536 * 1024 * 1024],
      ['amd', 'dedicated', 8 * GIB],
    ]);
  });
  it('reads nvidia-smi CSV in MiB', () => {
    expect(parseNvidiaSmi(P('nvidia-smi.txt')).map((g) => g.vramBytes)).toEqual([24564 * 1024 * 1024, 12288 * 1024 * 1024]);
    expect(parseNvidiaSmi('')).toEqual([]);
    expect(parseNvidiaSmi('Some GPU, [N/A]')[0]).toMatchObject({ vramBytes: null, vramConfidence: 'unknown' });
  });
  it('treats a capped Windows AdapterRAM as an estimate', () => {
    const g = parseWinVideoControllers(JSON.parse(P('win-video-controllers.json')));
    expect(g[0]).toMatchObject({ vendor: 'nvidia', memory: 'dedicated', vramConfidence: 'estimated' });
    expect(g[1]).toMatchObject({ vendor: 'intel', memory: 'shared', vramConfidence: 'measured' });
    expect(parseWinVideoControllers({ Name: 'Solo', AdapterRAM: null })).toHaveLength(1);
  });
  it('ignores garbage', () => {
    expect(parseSystemProfilerDisplays(null)).toEqual([]);
    expect(parseWinVideoControllers('nope')).toEqual([]);
  });
});

describe('detectHardware', () => {
  const deps = (over: Partial<ProbeDeps>): ProbeDeps => ({
    platform: 'darwin',
    arch: 'arm64',
    release: '24.6.0',
    cpus: () => Array.from({ length: 12 }, () => ({ model: 'Apple M3 Pro' })),
    totalmem: () => 32 * GIB,
    run: async () => P('system-profiler-apple.json'),
    freeDisk: async () => 400 * GIB,
    ...over,
  });
  it('builds a measured report from probe output', async () => {
    const r = await detectHardware(deps({}), '/tmp');
    expect(r.cpu.appleSilicon).toBe(true);
    expect(r.confidence).toEqual({ ram: 'measured', gpu: 'measured', disk: 'measured' });
    expect(r.notes).toEqual([]);
  });
  it('keeps going when probes fail, marking values unknown', async () => {
    const r = await detectHardware(deps({ platform: 'linux', arch: 'x64', run: async () => null, freeDisk: async () => null }), '/tmp');
    expect(r.gpus).toEqual([]);
    expect(r.confidence).toEqual({ ram: 'measured', gpu: 'unknown', disk: 'unknown' });
    expect(r.notes).toHaveLength(2);
  });
  it('only runs fixed binaries with fixed arguments', async () => {
    const calls: string[] = [];
    await detectHardware(deps({ platform: 'win32', arch: 'x64', run: async (f, a) => (calls.push([f, ...a].join(' ')), P('win-video-controllers.json')) }), 'C:\\');
    expect(calls).toEqual(['powershell.exe -NoProfile -NonInteractive -Command Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress']);
  });
});

describe('mode recommendation (SPEC 3.1, 5.1, 5.5)', () => {
  it('every fixture parses', () => {
    for (const n of HARDWARE_FIXTURE_NAMES) expect(hardwareFixture(n)).not.toBeNull();
    expect(hardwareFixture('nope')).toBeNull();
  });
  it.each([
    ['apple-silicon-32gb', 'local', 'apple_silicon'],
    ['windows-rtx-12gb', 'local', 'gpu'],
    ['windows-integrated-only', null, 'no_supported_gpu'],
    ['linux-gpu-unmeasured', null, 'no_supported_gpu'],
    ['linux-gtx-2gb', null, 'gpu_too_small'],
  ])('%s preselects %s (%s)', (name, preselect, reason) => {
    const r = recommendMode(fx(name), { minVramBytes: SMALLEST_CATALOG_ARTIFACT });
    expect(r.preselect).toBe(preselect);
    expect(r.local.reason).toBe(reason);
  });
  it('without a catalog, any measured dedicated memory counts', () => {
    expect(recommendMode(fx('linux-gtx-2gb')).preselect).toBe('local');
  });
  it('API and Hybrid are off until a provider is enabled by the terms review', () => {
    const off = recommendMode(fx('apple-silicon-32gb'));
    expect(off.options.filter((o) => o.available).map((o) => o.mode)).toEqual(['local']);
    const on = recommendMode(fx('apple-silicon-32gb'), { enabledProviders: ['openrouter'] });
    expect(on.options.every((o) => o.available)).toBe(true);
  });
  it('explains a policy mismatch instead of failing silently', () => {
    const r = recommendMode(fx('apple-silicon-32gb'));
    expect(causeFit(r, { apiAllowed: true }, 0).status).toBe('policy_mismatch');
    expect(causeFit(r, { apiAllowed: false }, 2).status).toBe('ready');
    expect(causeFit(recommendMode(fx('windows-integrated-only')), { apiAllowed: false }, 2).status).toBe('cpu_only');
  });
});

describe('runtime discovery is read-only and loopback-only', () => {
  it('lists Ollama models with normalized digests', async () => {
    const seen: string[] = [];
    const fetchFn = (async (u: URL, init?: RequestInit) => {
      seen.push(`${init?.method} ${u.pathname}`);
      if (u.pathname === '/api/version') return Response.json({ version: '0.12.3' });
      return new Response(P('ollama-tags.json'));
    }) as unknown as typeof fetch;
    const r = await discoverOllama('http://127.0.0.1:11434', fetchFn);
    expect(r).toMatchObject({ status: 'found', version: '0.12.3' });
    expect(r.models[0]).toEqual({ name: 'qwen2.5-coder:7b', digest: 'sha256-2b0496514337a3d5901f1d253d01726c890b721e891335a56d6e08cedf3e2cb0', sizeBytes: 4683087332 });
    expect(seen).toEqual(['GET /api/version', 'GET /api/tags']);
  });
  it('reports not found when nothing listens', async () => {
    const r = await discoverOllama('http://127.0.0.1:11434', (async () => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch);
    expect(r.status).toBe('not_found');
  });
  it('refuses an OLLAMA_HOST that is not loopback', async () => {
    expect(ollamaBaseUrl({})).toBe('http://127.0.0.1:11434');
    expect(ollamaBaseUrl({ OLLAMA_HOST: '0.0.0.0:11500' })).toBe('http://127.0.0.1:11500');
    expect(ollamaBaseUrl({ OLLAMA_HOST: 'http://[::1]:8080' })).toBe('http://[::1]:8080');
    expect(ollamaBaseUrl({ OLLAMA_HOST: 'gpu-box.lan:11434' })).toBeNull();
    expect((await discoverOllama(null, fetch)).status).toBe('error');
  });
  it('finds llama.cpp on PATH', async () => {
    expect((await discoverLlamaCpp(async (b) => (b === 'llama-cli' ? '/opt/bin/llama-cli' : null))).status).toBe('found');
    expect((await discoverLlamaCpp(async () => null)).status).toBe('not_found');
  });
});

describe('run rules and capability report', () => {
  it('defaults are the SPEC 7.2 defaults', () => {
    expect(DEFAULT_RUN_RULES).toMatchObject({ when: { kind: 'idle', idleMinutes: 5 }, power: 'plugged_in', network: 'not_metered', thermalCeilingC: 80, maxLoadPct: 75 });
  });
  it('never shows an unenforceable rule as enforced', () => {
    const lines = describeRunRules(DEFAULT_RUN_RULES, enforcementSupport('linux'));
    expect(lines.find((l) => l.rule === 'Network')?.enforcement).toBe('unavailable');
    expect(lines.find((l) => l.rule === 'Temperature')?.enforcement).toBe('unavailable');
    expect(describeRunRules(DEFAULT_RUN_RULES, enforcementSupport('darwin')).find((l) => l.rule === 'Power')?.enforcement).toBe('enforced');
  });
  it('minimizes the report: rounded sizes, no model names', () => {
    const c = minimizeCapabilities(fx('windows-rtx-12gb'), enforcementSupport('win32'));
    expect(c).toMatchObject({ os: 'win32', cpu_class: 'x86_64', ram_bytes: 64 * GIB, gpu_family: 'nvidia', vram_bytes: 12 * GIB, free_disk_bytes: 880 * GIB, confidence: 'measured' });
    expect(JSON.stringify(c)).not.toMatch(/RTX|Intel|Core/);
    const u = minimizeCapabilities(fx('linux-gpu-unmeasured'), enforcementSupport('linux'));
    expect(u).toMatchObject({ gpu_family: null, vram_bytes: null, confidence: 'unknown' });
    expect(minimizeCapabilities(fx('apple-silicon-32gb'), enforcementSupport('darwin'))).toMatchObject({ cpu_class: 'apple-silicon', gpu_family: 'apple', vram_bytes: null });
  });
});
