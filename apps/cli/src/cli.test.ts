import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApiClient } from '@swarm-explorer/api-client';
import { describe, expect, it } from 'vitest';
import { run, type Deps } from './cli';

const FIX = path.resolve(import.meta.dirname, '../../../packages/schema/fixtures/manifests');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const deps = (status: number, body: unknown): Deps => ({
  api: createApiClient({ baseUrl: 'http://x', fetch: async () => new Response(JSON.stringify(body), { status }) }),
  readFile: (p) => readFile(p, 'utf8'),
});

describe('swarm cli', () => {
  it('prints help and version', async () => {
    const c = capture();
    expect(await run(['--version'], c.io, deps(200, {}))).toBe(0);
    expect(c.out).toEqual(['0.1.0']);
    expect(await run([], c.io, deps(200, {}))).toBe(0);
    expect(c.out.at(-1)).toContain('swarm validate');
  });

  it('reports API errors with a nonzero exit', async () => {
    const c = capture();
    expect(await run(['show', 'nope'], c.io, deps(404, { error: { code: 'not_found', message: 'No such swarm' } }))).toBe(1);
    expect(c.err[0]).toContain('not_found');
  });

  it('reserved commands exit 3 with their milestone; unknown ones exit 2', async () => {
    const c = capture();
    expect(await run(['publish'], c.io, deps(200, {}))).toBe(3);
    expect(c.err[0]).toContain('M11');
    expect(await run(['frobnicate'], c.io, deps(200, {}))).toBe(2);
    expect(await run(['swarms', '--category', 'games'], c.io, deps(200, {}))).toBe(2);
  });

  it('lists swarms', async () => {
    const c = capture();
    expect(await run(['swarms'], c.io, deps(200, { items: [] }))).toBe(0);
    expect(c.out.at(-1)).toBe('0 swarms (example data)');
  });

  it('validates manifests from disk', async () => {
    const ok = capture();
    expect(await run(['validate', path.join(FIX, 'valid/challenge-vaults.yaml')], ok.io, deps(200, {}))).toBe(0);
    expect(ok.out[0]).toContain('"challenge-vaults"');
    const bad = capture();
    const tmp = { ...deps(200, {}), readFile: async () => 'manifest_version: 1\nid: x\n' };
    expect(await run(['validate', 'x.yaml'], bad.io, tmp)).toBe(1);
    expect(bad.err.length).toBeGreaterThan(0);
  });
});
