/**
 * Verification records (SPEC 8.2) and the verifier request signature. Every record is signed by the
 * verifier that produced it, over a canonical payload, so the ledger can check its authenticity
 * before pending credit is created. Pure: no I/O, usable in the coordinator and the worker.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@swarm-explorer/schema';

export const VERIFICATION_METHODS = ['machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** What a verifier decides about one subject. */
export type Verdict = {
  outcome: 'accepted' | 'rejected';
  /** A short snake_case code. Shown to operators, never to the node for known answers. */
  rationaleCode: string;
  /** sha256-<hex> digests of what the verifier looked at (checked file, transcript, panel). */
  evidenceHashes: string[];
  verifierVersion: string;
  /** Juror panel ids, model families and diversity checks, when a panel was used. */
  panel?: Record<string, unknown> | null;
};

/**
 * One Verifier interface keyed by the manifest's method (SPEC 8.1). `verify` returns null when it
 * cannot decide yet (for example a redundancy group that is not complete); the subject then stays in
 * Verifying.
 */
export interface Verifier<Input> {
  readonly method: VerificationMethod;
  readonly version: string;
  verify(input: Input): Promise<Verdict | null> | Verdict | null;
}

export type SubjectType = 'result' | 'qualification_attempt';

export type RecordPayload = {
  subject_type: SubjectType;
  subject_id: string;
  method: VerificationMethod;
  verifier_version: string;
  evidence_hashes: string[];
  /** The output hash the verifier checked; must equal the stored result hash. */
  result_hash: string;
  outcome: 'accepted' | 'rejected';
  rationale_code: string;
  panel: Record<string, unknown> | null;
};

export const RECORD_PREFIX = 'swarm-explorer-verification-v1\n';

export function recordPayload(subject: { type: SubjectType; id: string }, method: VerificationMethod, resultHash: string, v: Verdict): RecordPayload {
  return {
    subject_type: subject.type,
    subject_id: subject.id,
    method,
    verifier_version: v.verifierVersion,
    evidence_hashes: v.evidenceHashes,
    result_hash: resultHash,
    outcome: v.outcome,
    rationale_code: v.rationaleCode,
    panel: v.panel ?? null,
  };
}

export function verificationRecordMessage(p: RecordPayload): string {
  return RECORD_PREFIX + canonicalJson(p);
}

export const digest = (data: string | Uint8Array) => `sha256-${createHash('sha256').update(data).digest('hex')}`;
export const canonicalDigest = (v: unknown) => digest(canonicalJson(v));

/** A key that signs records: Ed25519, SPKI DER base64url for the public half. */
export type SigningKey = { keyId: string; privateKey: KeyObject; publicKey: string };

export function signingKeyFromPkcs8(keyId: string, pkcs8Base64url: string): SigningKey {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8Base64url, 'base64url'), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url');
  return { keyId, privateKey, publicKey };
}

/** `keyId:base64url` over the record message. */
export function signRecord(key: SigningKey, p: RecordPayload): string {
  return `${key.keyId}:${sign(null, Buffer.from(verificationRecordMessage(p)), key.privateKey).toString('base64url')}`;
}

export function verifySignature(publicKeySpkiB64u: string, message: string, signatureB64u: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiB64u, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signatureB64u, 'base64url'));
  } catch {
    return false;
  }
}

/** Splits `keyId:signature`; null when malformed. */
export function splitSignature(s: string): { keyId: string; signature: string } | null {
  const i = s.lastIndexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { keyId: s.slice(0, i), signature: s.slice(i + 1) };
}

/* ----------------------------------------------------------------------------
 * Verifier worker requests: signed like device requests, with their own prefix and nonces.
 * ------------------------------------------------------------------------- */

export const VERIFIER_HEADERS = {
  keyId: 'x-verifier-key',
  ts: 'x-verifier-ts',
  nonce: 'x-verifier-nonce',
  signature: 'x-verifier-signature',
} as const;

export const VERIFIER_NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export function verifierRequestMessage(o: { method: string; path: string; bodySha256: string; ts: number; nonce: string }): string {
  return ['swarm-explorer-verifier-v1', o.method.toUpperCase(), o.path, o.bodySha256, String(o.ts), o.nonce].join('\n');
}

export const bodySha256 = (body: string) => createHash('sha256').update(body).digest('base64url');
