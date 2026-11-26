/**
 * Node-only helpers: publisher signatures and content-addressed harness bundles
 * (SPEC 6.1, 6.5, 11.6). Uses node:crypto and node:fs, so never import from a renderer.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, signingPayload } from './canonical';
import type { Digest, ManifestSignature, ManifestV1 } from './types';

export function sha256Digest(data: Uint8Array | string): Digest {
  return `sha256-${createHash('sha256').update(data).digest('hex')}`;
}

/** A publisher key as registered with the platform (SPEC 12.2 publisher_keys). */
export interface RegisteredKey {
  keyId: string;
  publisher: string;
  /** SPKI DER, base64. */
  publicKey: string;
  status: 'active' | 'revoked';
}

export function generatePublisherKey(keyId: string): { keyId: string; privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** Sign a manifest. Any existing signature by the same key is replaced; others are kept (co-signing). */
export function signManifestV1(m: ManifestV1, key: { keyId: string; privateKeyPem: string }): ManifestV1 {
  const payload = signingPayload(m as unknown as Record<string, unknown>);
  const signature = sign(null, Buffer.from(payload), createPrivateKey(key.privateKeyPem)).toString('base64');
  const others = (m.signatures ?? []).filter((s) => s.key_id !== key.keyId);
  return { ...m, signatures: [...others, { key_id: key.keyId, algorithm: 'ed25519', signature }] };
}

export type SignatureCheck = { ok: true; keyId: string } | { ok: false; reason: 'unsigned' | 'unknown_key' | 'revoked_key' | 'wrong_publisher' | 'bad_signature' };

/**
 * A manifest is trusted when at least one signature verifies under an active key that
 * the registry assigns to the manifest's own publisher (SPEC 11.6). Revoked or foreign
 * keys never count, even if the signature math is valid.
 */
export function verifyManifestSignatures(m: ManifestV1, lookup: (keyId: string) => RegisteredKey | undefined): SignatureCheck {
  const sigs: ManifestSignature[] = m.signatures ?? [];
  if (!sigs.length) return { ok: false, reason: 'unsigned' };
  const payload = Buffer.from(signingPayload(m as unknown as Record<string, unknown>));
  let worst: Exclude<SignatureCheck, { ok: true }>['reason'] = 'unknown_key';
  const rank = { unknown_key: 0, wrong_publisher: 1, revoked_key: 2, bad_signature: 3, unsigned: 4 } as const;
  const note = (r: typeof worst) => {
    if (rank[r] > rank[worst]) worst = r;
  };
  for (const s of sigs) {
    const key = lookup(s.key_id);
    if (!key) continue;
    if (key.publisher !== m.publisher) {
      note('wrong_publisher');
      continue;
    }
    if (key.status !== 'active') {
      note('revoked_key');
      continue;
    }
    let good = false;
    try {
      const pub = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
      good = verify(null, payload, pub, Buffer.from(s.signature, 'base64'));
    } catch {
      good = false;
    }
    if (good) return { ok: true, keyId: s.key_id };
    note('bad_signature');
  }
  return { ok: false, reason: worst };
}

/** One file in a bundle index. Paths use forward slashes, relative to the bundle root. */
export interface BundleFile {
  path: string;
  size: number;
  sha256: Digest;
}

/**
 * Content address of a harness bundle directory (SPEC 6.1): sha256 over the canonical
 * JSON index of every regular file (path, size, digest), sorted by path. Symlinks and
 * special files are refused, so a bundle cannot point outside itself.
 */
export function bundleIndex(root: string): BundleFile[] {
  const files: BundleFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = lstatSync(full);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (st.isSymbolicLink()) throw new Error(`Bundle contains a symlink: ${rel}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const data = readFileSync(full);
        files.push({ path: rel, size: data.byteLength, sha256: sha256Digest(data) });
      } else throw new Error(`Bundle contains a special file: ${rel}`);
    }
  };
  walk(root);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function bundleDigest(root: string): Digest {
  return sha256Digest(canonicalJson({ bundle_index_version: 1, files: bundleIndex(root) }));
}

/* Platform signed statements (M7): kill switch entries and contribution receipts. */
export * from './signed';
export * from './receipt';
