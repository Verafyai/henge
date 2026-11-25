/**
 * Signed client update manifests (SPEC 11.2, 15.1). Node only: used by the API, the
 * release signing script and the desktop client's main process.
 *
 * The signature covers the exact manifest string, so there is no JSON
 * canonicalization to get wrong. The client verifies the signature with a
 * public key compiled into the build, then parses, then applies policy.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

export const manifestSchema = z.object({
  schema: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  channel: z.enum(['stable', 'beta', 'internal']),
  platform: z.string(),
  arch: z.string(),
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
  publishedAt: z.iso.datetime({ offset: true }),
  /** Signed permission to move installs to an older version (A8.3 "rollback manifest"). */
  rollback: z.boolean(),
  notes: z.string(),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** What GET /api/v1/releases/latest returns when a release exists. */
export const signedManifestSchema = z.object({ manifest: z.string().max(8192), signature: z.string().max(200) });
export type SignedManifest = z.infer<typeof signedManifestSchema>;

const b64u = (b: Buffer) => b.toString('base64url');

export function generateReleaseKeyPair(): { privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' })),
  };
}

export function publicKeyFromString(spkiB64u: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiB64u, 'base64url'), format: 'der', type: 'spki' });
}

export function signManifest(m: Manifest, privateKeyPem: string): SignedManifest {
  const manifest = JSON.stringify(manifestSchema.parse(m));
  const signature = b64u(sign(null, Buffer.from(manifest), createPrivateKey(privateKeyPem)));
  return { manifest, signature };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Semver precedence, enough for release versions and dotted prereleases. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main = '', pre] = v.split(/-(.*)/s);
    return { nums: main.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export type UpdatePolicy = {
  currentVersion: string;
  channel: Manifest['channel'];
  platform: string;
  arch: string;
  publicKey: string;
  /** Release CDN hosts the artifact may come from. HTTPS only. */
  pinnedHosts: string[];
  /** Development only: also accept http://localhost and 127.0.0.1 artifact URLs. */
  allowLocalHttp?: boolean;
};

export type UpdateDecision =
  | { kind: 'none'; reason: string }
  | { kind: 'available'; manifest: Manifest }
  | { kind: 'rejected'; reason: string };

/** Verifies a signed manifest and decides whether to offer it. Never throws. */
export function evaluateUpdate(signed: unknown, policy: UpdatePolicy): UpdateDecision {
  const env = signedManifestSchema.safeParse(signed);
  if (!env.success) return { kind: 'rejected', reason: 'malformed envelope' };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(env.data.manifest), publicKeyFromString(policy.publicKey), Buffer.from(env.data.signature, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return { kind: 'rejected', reason: 'bad signature' };
  let raw: unknown;
  try {
    raw = JSON.parse(env.data.manifest);
  } catch {
    return { kind: 'rejected', reason: 'manifest is not JSON' };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'rejected', reason: 'manifest fails schema' };
  const m = parsed.data;
  if (m.channel !== policy.channel || m.platform !== policy.platform || m.arch !== policy.arch) {
    return { kind: 'rejected', reason: 'manifest is for a different channel or platform' };
  }
  const u = new URL(m.url);
  const local = policy.allowLocalHttp && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (!local && (u.protocol !== 'https:' || !policy.pinnedHosts.includes(u.hostname))) {
    return { kind: 'rejected', reason: 'artifact host is not pinned' };
  }
  const cmp = compareVersions(m.version, policy.currentVersion);
  if (cmp === 0) return { kind: 'none', reason: 'up to date' };
  if (cmp < 0 && !m.rollback) return { kind: 'rejected', reason: 'downgrade without a signed rollback manifest' };
  return { kind: 'available', manifest: m };
}

/** Checked after download and before handing the file to the OS installer. */
export function verifyArtifact(bytes: Uint8Array, m: Pick<Manifest, 'sha256' | 'size'>): boolean {
  return bytes.byteLength === m.size && sha256Hex(bytes) === m.sha256;
}
