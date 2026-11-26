/**
 * Contribution receipts (M7; SPEC 4.2 Result/receipt, 8.2, 9.2). The platform issues one signed
 * receipt per settled result. It states only what the ledger and the verification records say: the
 * swarm and release, the pins, the output hash, the methods that accepted it, when each state was
 * reached and what it earned. A volunteer receipt carries impact and never credits.
 *
 * Anyone can verify a receipt offline: `verifyReceipt` checks the shape and the Ed25519 signature
 * over `swarm-explorer-receipt-v1\n` + the canonical receipt without `signature`. The receipt names the
 * key it was signed with; pass the platform's published receipt keys (`GET /v1/receipts/keys`) as
 * `trustedKeys` to also check that key is the platform's.
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { canonicalJson } from './canonical';
import { RECEIPT_PREFIX, signStatement, splitStatementSignature, verifyStatement, type PlatformPublicKey } from './signed';
import type { KeyObject } from 'node:crypto';

const DIGEST = '^sha256-[a-f0-9]{64}$';
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const ISO = { type: 'string', format: 'date-time' } as const;
const digest = { type: 'string', pattern: DIGEST } as const;

export const receiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://henge.verafy.ai/schemas/receipt-v1.json',
  title: 'Henge contribution receipt v1',
  type: 'object',
  additionalProperties: false,
  required: ['receipt_version', 'receipt_id', 'issued_at', 'result', 'swarm', 'pins', 'verification', 'timeline', 'earned', 'contributor', 'signer', 'signature'],
  properties: {
    receipt_version: { const: 1 },
    receipt_id: { type: 'string', pattern: UUID },
    issued_at: ISO,
    result: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'state', 'output_sha256'],
      properties: { id: { type: 'string', pattern: UUID }, state: { const: 'settled' }, output_sha256: digest },
    },
    swarm: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'funded', 'release_manifest_hash'],
      properties: { slug: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, funded: { type: 'boolean' }, release_manifest_hash: digest },
    },
    pins: {
      type: 'object',
      additionalProperties: false,
      required: ['harness', 'model_artifact_hash', 'permissions_hash'],
      properties: {
        harness: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'version', 'hash'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, version: { type: 'string', minLength: 1, maxLength: 64 }, hash: digest },
        },
        model_artifact_hash: { anyOf: [digest, { type: 'null' }] },
        permissions_hash: digest,
      },
    },
    verification: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'outcome', 'verifier_version', 'verifier_key_id'],
        properties: {
          method: { enum: ['machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review'] },
          outcome: { const: 'accepted' },
          verifier_version: { type: 'string', minLength: 1, maxLength: 120 },
          verifier_key_id: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
    },
    timeline: {
      type: 'object',
      additionalProperties: false,
      required: ['submitted_at', 'pending_at', 'settled_at'],
      properties: { submitted_at: ISO, pending_at: ISO, settled_at: ISO },
    },
    earned: {
      type: 'object',
      additionalProperties: false,
      required: ['impact_units', 'credits'],
      properties: {
        impact_units: { type: 'integer', minimum: 0 },
        credits: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
      },
    },
    contributor: {
      type: 'object',
      additionalProperties: false,
      required: ['account_id'],
      properties: { account_id: { type: 'string', pattern: UUID } },
    },
    signer: {
      type: 'object',
      additionalProperties: false,
      required: ['key_id', 'public_key'],
      properties: { key_id: { type: 'string', minLength: 1, maxLength: 120 }, public_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{40,200}$' } },
    },
    signature: { type: 'string', minLength: 10, maxLength: 300 },
  },
  // Volunteer work never earns credits (SPEC 9.1).
  if: { type: 'object', required: ['swarm'], properties: { swarm: { type: 'object', required: ['funded'], properties: { funded: { const: false } } } } },
  then: { type: 'object', properties: { earned: { type: 'object', properties: { credits: { type: 'null' } } } } },
} as const;

export type Receipt = {
  receipt_version: 1;
  receipt_id: string;
  issued_at: string;
  result: { id: string; state: 'settled'; output_sha256: string };
  swarm: { slug: string; funded: boolean; release_manifest_hash: string };
  pins: { harness: { name: string; version: string; hash: string }; model_artifact_hash: string | null; permissions_hash: string };
  verification: Array<{ method: 'machine-check' | 'known-answers' | 'redundancy' | 'jury' | 'publisher-review'; outcome: 'accepted'; verifier_version: string; verifier_key_id: string }>;
  timeline: { submitted_at: string; pending_at: string; settled_at: string };
  earned: { impact_units: number; credits: number | null };
  contributor: { account_id: string };
  signer: { key_id: string; public_key: string };
  signature: string;
};
export type UnsignedReceipt = Omit<Receipt, 'signature'>;

let validator: ValidateFunction | null = null;
function validate(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: false });
    validator = ajv.compile(receiptSchema);
  }
  return validator;
}

/** The bytes the platform signs: the canonical receipt without `signature`. */
export function receiptMessage(r: UnsignedReceipt): string {
  return canonicalJson(r);
}

export function signReceipt(r: UnsignedReceipt, key: { keyId: string; privateKey: KeyObject }): Receipt {
  if (r.signer.key_id !== key.keyId) throw new Error('The receipt names a different signer.');
  return { ...r, signature: signStatement(RECEIPT_PREFIX, receiptMessage(r), key) };
}

export type ReceiptCheck =
  | { ok: true; receipt: Receipt; keyId: string; keyTrusted: boolean | null }
  | { ok: false; reason: 'malformed' | 'schema' | 'bad_signature' | 'untrusted_key' | 'revoked_key'; detail: string };

/**
 * Verifies a receipt offline. With `trustedKeys` the signing key must be one of them and active;
 * without, the signature is checked against the key the receipt names and `keyTrusted` is null, which
 * proves the receipt is intact but not who issued it.
 */
export function verifyReceipt(value: unknown, trustedKeys?: ReadonlyArray<PlatformPublicKey>): ReceiptCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'malformed', detail: 'A receipt is a JSON object.' };
  const v = validate();
  if (!v(value)) {
    const e = v.errors?.[0];
    return { ok: false, reason: 'schema', detail: `${e?.instancePath || '/'} ${e?.message ?? 'is invalid'}` };
  }
  const r = value as Receipt;
  const { signature, ...unsigned } = r;
  const parts = splitStatementSignature(signature);
  if (!parts || parts.keyId !== r.signer.key_id) return { ok: false, reason: 'bad_signature', detail: 'The signature does not name the receipt signer.' };
  if (!verifyStatement(RECEIPT_PREFIX, receiptMessage(unsigned), signature, r.signer.public_key)) return { ok: false, reason: 'bad_signature', detail: 'The signature does not match the receipt.' };
  if (!trustedKeys) return { ok: true, receipt: r, keyId: parts.keyId, keyTrusted: null };
  const key = trustedKeys.find((k) => k.key_id === parts.keyId);
  if (!key || key.public_key !== r.signer.public_key) return { ok: false, reason: 'untrusted_key', detail: `Key ${parts.keyId} is not one of the trusted receipt keys.` };
  if (key.status !== 'active') return { ok: false, reason: 'revoked_key', detail: `Key ${parts.keyId} was revoked.` };
  return { ok: true, receipt: r, keyId: parts.keyId, keyTrusted: true };
}
