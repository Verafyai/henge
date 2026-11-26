import { generateReleaseKeyPair, sha256Hex, signManifest, type Manifest } from '@swarm-explorer/api-client/release';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkForUpdates, downloadUpdate, mirrorBase } from './updates';

const keys = generateReleaseKeyPair();
const m: Manifest = {
  schema: 1,
  version: '0.2.0-internal.1',
  channel: 'internal',
  platform: 'darwin',
  arch: 'arm64',
  url: 'https://releases.swarm-explorer.test/internal/0.2.0-internal.1/a.zip',
  sha256: sha256Hex(Buffer.from('x')),
  size: 1,
  publishedAt: '2026-11-25T00:00:00.000Z',
  rollback: false,
  notes: 'Example',
};
const serve = (status: number, body?: unknown): typeof fetch => async () => new Response(body === undefined ? null : JSON.stringify(body), { status });
const base = { apiBaseUrl: 'http://api.test', currentVersion: '0.1.0', channel: 'dev' as const, platform: 'darwin', arch: 'arm64', publicKey: keys.publicKey, installId: null };

describe('checkForUpdates', () => {
  it('offers a verified update on the internal channel for dev builds', async () => {
    const r = await checkForUpdates({ ...base, fetch: serve(200, signManifest(m, keys.privateKeyPem)) });
    expect(r).toMatchObject({ kind: 'available', version: '0.2.0-internal.1' });
  });

  it('refuses a tampered manifest', async () => {
    const signed = signManifest(m, keys.privateKeyPem);
    const r = await checkForUpdates({ ...base, fetch: serve(200, { ...signed, manifest: signed.manifest.replace('0.2.0-internal.1', '9.9.9') }) });
    expect(r).toEqual({ kind: 'rejected', message: 'Update refused: bad signature.' });
  });

  it('handles no release, server errors and builds without a key', async () => {
    expect((await checkForUpdates({ ...base, fetch: serve(204) })).kind).toBe('none');
    expect((await checkForUpdates({ ...base, fetch: serve(500, {}) })).kind).toBe('error');
    expect((await checkForUpdates({ ...base, publicKey: null, fetch: serve(204) })).kind).toBe('unavailable');
  });
});

describe('downloadUpdate (M7)', () => {
  const payload = Buffer.from('Henge test payload');
  const pm: Manifest = { ...m, sha256: sha256Hex(payload), size: payload.byteLength };
  const fetchWith = (artifact: Buffer, seen: string[] = []): typeof fetch =>
    (async (u: URL | string) => {
      seen.push(String(u));
      return String(u).includes('/v1/releases/latest') ? new Response(JSON.stringify(signManifest(pm, keys.privateKeyPem))) : new Response(new Uint8Array(artifact));
    }) as typeof fetch;

  it('downloads from the mirror for the pinned test host, checks the signed hash and stages the file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'henge-upd-'));
    const seen: string[] = [];
    const r = await downloadUpdate({ ...base, fetch: fetchWith(payload, seen), stagingDir: dir, mirror: mirrorBase('http://127.0.0.1:4555') });
    expect(r).toMatchObject({ kind: 'staged', version: '0.2.0-internal.1' });
    expect(seen[1]).toBe('http://127.0.0.1:4555/internal/0.2.0-internal.1/a.zip');
    expect(readFileSync(path.join(dir, '0.2.0-internal.1', 'a.zip'))).toEqual(payload);
    expect(r.message).toContain('Installing updates is not available');
  });

  it('refuses bytes that do not match the signed hash or size, and stages nothing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'henge-upd-'));
    const wrong = Buffer.from('Henge test paylOad');
    expect(await downloadUpdate({ ...base, fetch: fetchWith(wrong), stagingDir: dir, mirror: null })).toEqual({ kind: 'rejected', message: 'Update refused: the download does not match its signed hash.' });
    expect((await downloadUpdate({ ...base, fetch: fetchWith(Buffer.concat([payload, payload])), stagingDir: dir, mirror: null })).kind).toBe('rejected');
    expect(existsSync(path.join(dir, '0.2.0-internal.1'))).toBe(false);
  });

  it('accepts only a local http mirror', () => {
    expect(mirrorBase('https://evil.example')).toBeNull();
    expect(mirrorBase('http://10.0.0.1:80')).toBeNull();
    expect(mirrorBase('nope')).toBeNull();
    expect(mirrorBase('http://localhost:9/x')).toBe('http://localhost:9');
  });
});
