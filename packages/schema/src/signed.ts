/**
 * Platform signed statements (M7): kill switch entries in the revocation feed (SPEC 11.6) and
 * contribution receipts. Each kind has its own message prefix, so a signature for one can never be
 * replayed as the other. Ed25519 over `prefix + canonical JSON`; signatures are `keyId:base64url` and
 * public keys are SPKI DER base64url, like verification records. Node only (node:crypto).
 */
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical';

export const REVOCATION_PREFIX = 'swarm-explorer-revocation-v1\n';
export const RECEIPT_PREFIX = 'swarm-explorer-receipt-v1\n';

/** A platform public key as the API publishes it. */
export type PlatformPublicKey = { key_id: string; public_key: string; status: 'active' | 'revoked' };

export function signStatement(prefix: string, canonical: string, key: { keyId: string; privateKey: KeyObject }): string {
  return `${key.keyId}:${sign(null, Buffer.from(prefix + canonical), key.privateKey).toString('base64url')}`;
}

/** Splits `keyId:signature`; null when malformed. */
export function splitStatementSignature(s: string): { keyId: string; signature: string } | null {
  const i = s.lastIndexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { keyId: s.slice(0, i), signature: s.slice(i + 1) };
}

export function verifyStatement(prefix: string, canonical: string, signature: string, publicKeySpkiB64u: string): boolean {
  const parts = splitStatementSignature(signature);
  if (!parts) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiB64u, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(prefix + canonical), key, Buffer.from(parts.signature, 'base64url'));
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * Kill switch entries (SPEC 11.6)
 * ------------------------------------------------------------------------- */

export const KILL_TARGETS = ['platform', 'swarm'] as const;
export type KillTarget = (typeof KILL_TARGETS)[number];

/**
 * What the platform signs for one revocation feed entry. `revoke` stops the target and `restore`
 * lifts it; the newest entry per target decides. `target_id` is `*` for the platform and the swarm
 * slug for a swarm. Nodes read the state from this signed payload, never from unsigned feed fields.
 */
export type RevocationPayload = {
  revocation_version: 1;
  id: string;
  target_type: string;
  target_id: string;
  action: 'revoke' | 'restore';
  reason: string;
  severity: 'low' | 'high' | 'critical';
  effective_at: string;
};

export function revocationCanonical(p: RevocationPayload): string {
  return canonicalJson(p);
}

/** Parses a signed payload string; null unless it is exactly a v1 revocation payload in canonical form. */
export function parseRevocationPayload(signedPayload: string): RevocationPayload | null {
  let v: unknown;
  try {
    v = JSON.parse(signedPayload);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  const keys = ['action', 'effective_at', 'id', 'reason', 'revocation_version', 'severity', 'target_id', 'target_type'];
  if (Object.keys(p).sort().join(',') !== keys.join(',')) return null;
  if (p['revocation_version'] !== 1 || (p['action'] !== 'revoke' && p['action'] !== 'restore')) return null;
  if (!['low', 'high', 'critical'].includes(String(p['severity']))) return null;
  for (const k of ['id', 'target_type', 'target_id', 'reason', 'effective_at']) if (typeof p[k] !== 'string') return null;
  if (Number.isNaN(Date.parse(String(p['effective_at'])))) return null;
  // Only the canonical form is accepted, so the signed bytes have one meaning.
  if (canonicalJson(p) !== signedPayload) return null;
  return p as unknown as RevocationPayload;
}

/** A feed entry checked against a set of trusted keys: the payload when the signature verifies, else null. */
export function verifiedRevocation(entry: { signedPayload: string; signature: string | null }, keys: ReadonlyArray<PlatformPublicKey>): RevocationPayload | null {
  if (!entry.signature) return null;
  const parts = splitStatementSignature(entry.signature);
  const key = parts && keys.find((k) => k.key_id === parts.keyId && k.status === 'active');
  if (!key || !verifyStatement(REVOCATION_PREFIX, entry.signedPayload, entry.signature, key.public_key)) return null;
  return parseRevocationPayload(entry.signedPayload);
}

export type KillState = {
  /** The platform wide stop, when one is in force. */
  global: RevocationPayload | null;
  /** Stopped swarms by slug. */
  swarms: Record<string, RevocationPayload>;
};

/**
 * The kill state from verified entries: the newest entry per target decides (later `effective_at`
 * wins; entries effective in the future are ignored until then).
 */
export function killStateOf(entries: ReadonlyArray<RevocationPayload>, now = new Date()): KillState {
  const latest = new Map<string, RevocationPayload>();
  for (const e of entries) {
    if (e.target_type !== 'platform' && e.target_type !== 'swarm') continue;
    if (Date.parse(e.effective_at) > now.getTime()) continue;
    const k = `${e.target_type}:${e.target_id}`;
    const cur = latest.get(k);
    if (!cur || Date.parse(e.effective_at) >= Date.parse(cur.effective_at)) latest.set(k, e);
  }
  const state: KillState = { global: null, swarms: {} };
  for (const e of latest.values()) {
    if (e.action !== 'revoke') continue;
    if (e.target_type === 'platform') state.global = e;
    else state.swarms[e.target_id] = e;
  }
  return state;
}
