/**
 * Canonical JSON for signing (SPEC 6.5): RFC 8785 JSON Canonicalization Scheme.
 * Object keys sorted by UTF-16 code units, no whitespace, strings and numbers as
 * ECMAScript JSON.stringify writes them (which is what RFC 8785 specifies).
 * Non-finite numbers, undefined, functions and other non-JSON values are refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot encode a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, v]) => v === undefined)) throw new TypeError('Canonical JSON cannot encode undefined.');
    // Default sort compares UTF-16 code units, as RFC 8785 requires.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

/** The bytes a publisher signs: the canonical manifest without its `signatures` field. */
export function signingPayload(manifest: Record<string, unknown>): string {
  const { signatures: _omit, ...unsigned } = manifest;
  return canonicalJson(unsigned);
}

const DIGEST_RE = /^sha256[-:]([a-f0-9]{64})$/;

/**
 * Normalize a digest to the manifest form `sha256-<hex>`. API documents may write
 * `sha256:<hex>` for the same digest (SPEC 6.5); anything else returns null.
 */
export function normalizeDigest(d: string): `sha256-${string}` | null {
  const m = DIGEST_RE.exec(d.trim().toLowerCase());
  return m ? `sha256-${m[1]}` : null;
}
