import { generateReleaseKeyPair, sha256Hex, signManifest, type Manifest } from '@swarm-explorer/api-client/release';
import { describe, expect, it } from 'vitest';
import { checkForUpdates } from './updates';

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
