import { describe, expect, it } from 'vitest';
import { compareVersions, evaluateUpdate, generateReleaseKeyPair, sha256Hex, signManifest, verifyArtifact, type Manifest, type UpdatePolicy } from './release';

const keys = generateReleaseKeyPair();
const other = generateReleaseKeyPair();
const artifact = new TextEncoder().encode('example artifact bytes');

const manifest: Manifest = {
  schema: 1,
  version: '0.2.0-internal.20261125',
  channel: 'internal',
  platform: 'darwin',
  arch: 'arm64',
  url: 'https://releases.example.test/internal/0.2.0/SwarmExplorer.zip',
  sha256: sha256Hex(artifact),
  size: artifact.byteLength,
  publishedAt: '2026-11-25T00:00:00.000Z',
  rollback: false,
  notes: 'Example notes',
};

const policy: UpdatePolicy = {
  currentVersion: '0.1.0',
  channel: 'internal',
  platform: 'darwin',
  arch: 'arm64',
  publicKey: keys.publicKey,
  pinnedHosts: ['releases.example.test'],
};

describe('compareVersions', () => {
  it('follows semver precedence', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-internal.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-internal.10', '1.0.0-internal.9')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
});

describe('evaluateUpdate', () => {
  it('accepts a correctly signed newer manifest', () => {
    expect(evaluateUpdate(signManifest(manifest, keys.privateKeyPem), policy)).toMatchObject({ kind: 'available' });
  });

  it('rejects a tampered manifest', () => {
    const signed = signManifest(manifest, keys.privateKeyPem);
    const tampered = { ...signed, manifest: signed.manifest.replace('releases.example.test', 'evil.example.test') };
    expect(evaluateUpdate(tampered, policy)).toEqual({ kind: 'rejected', reason: 'bad signature' });
  });

  it('rejects a manifest signed by another key', () => {
    expect(evaluateUpdate(signManifest(manifest, other.privateKeyPem), policy)).toEqual({ kind: 'rejected', reason: 'bad signature' });
  });

  it('rejects unpinned hosts and plain http', () => {
    const r = evaluateUpdate(signManifest({ ...manifest, url: 'https://cdn.other.test/x.zip' }, keys.privateKeyPem), policy);
    expect(r).toEqual({ kind: 'rejected', reason: 'artifact host is not pinned' });
    const h = evaluateUpdate(signManifest({ ...manifest, url: 'http://releases.example.test/x.zip' }, keys.privateKeyPem), policy);
    expect(h.kind).toBe('rejected');
  });

  it('blocks downgrades unless the manifest is a signed rollback', () => {
    const old = { ...manifest, version: '0.0.9' };
    expect(evaluateUpdate(signManifest(old, keys.privateKeyPem), policy)).toEqual({ kind: 'rejected', reason: 'downgrade without a signed rollback manifest' });
    expect(evaluateUpdate(signManifest({ ...old, rollback: true }, keys.privateKeyPem), policy).kind).toBe('available');
  });

  it('rejects other channels and reports up to date', () => {
    expect(evaluateUpdate(signManifest({ ...manifest, channel: 'stable' }, keys.privateKeyPem), policy).kind).toBe('rejected');
    expect(evaluateUpdate(signManifest(manifest, keys.privateKeyPem), { ...policy, currentVersion: manifest.version })).toEqual({ kind: 'none', reason: 'up to date' });
  });

  it('never throws on junk', () => {
    expect(evaluateUpdate(null, policy).kind).toBe('rejected');
    expect(evaluateUpdate({ manifest: '{', signature: 'x' }, policy).kind).toBe('rejected');
  });
});

describe('verifyArtifact', () => {
  it('checks sha256 and size', () => {
    expect(verifyArtifact(artifact, manifest)).toBe(true);
    expect(verifyArtifact(new TextEncoder().encode('example artifact byteZ'), manifest)).toBe(false);
  });
});
