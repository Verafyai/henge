/**
 * Canonical bundle digest (spin-out spec v2, 6.6). Uses Web Crypto, so it runs in Node, the
 * client main process and a browser alike.
 *
 *   digest = sha256( concat over files sorted by path of  `${path}\0${sha256hex(file)}\n` )
 *
 * `henge.yaml` is hashed as its canonical JSON (canonical.ts, sorted keys) rather than its
 * bytes, without the fields that cannot be inside the thing they describe: `signatures`
 * (they sign this digest), `source.bundle_digest` (it is this digest) and `source.commit`
 * (a commit hash covers the file that would contain it).
 */
import { canonicalJson } from './canonical';
import type { HengeBundleFiles } from './henge-validate';
import type { Digest } from './types';
import { parseManifestSource } from './yaml';

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

/** The canonical text of a parsed henge.yaml that the digest covers. */
export function hengeDigestPayload(henge: Record<string, unknown>): string {
  const { signatures: _sig, ...rest } = henge;
  const source = rest.source;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const { bundle_digest: _d, commit: _c, ...src } = source as Record<string, unknown>;
    rest.source = src;
  }
  return canonicalJson(rest);
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `sha256-<hex>` over a whole bundle. Throws if henge.yaml is missing or does not parse. */
export async function hengeBundleDigest(files: HengeBundleFiles): Promise<Digest> {
  const manifest = files.get('henge.yaml');
  if (!manifest) throw new Error('A .henge bundle needs henge.yaml at its root.');
  const parsed = parseManifestSource(new TextDecoder().decode(manifest));
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) throw new Error('henge.yaml does not parse as a YAML mapping.');
  const payload = hengeDigestPayload(parsed.value as Record<string, unknown>);
  let list = '';
  for (const path of [...files.keys()].sort(byPath)) {
    const fileHex = path === 'henge.yaml' ? await sha256Hex(payload) : await sha256Hex(files.get(path)!);
    list += `${path}\0${fileHex}\n`;
  }
  return `sha256-${await sha256Hex(list)}`;
}

/** Single-file form: the file is a one-file bundle whose only member is henge.yaml. */
export function hengeFileDigest(source: string): Promise<Digest> {
  return hengeBundleDigest(new Map([['henge.yaml', enc.encode(source)]]));
}
