import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical';
import { receiptMessage, signReceipt, verifyReceipt, type UnsignedReceipt } from './receipt';
import { killStateOf, parseRevocationPayload, REVOCATION_PREFIX, revocationCanonical, signStatement, verifiedRevocation, verifyStatement, type RevocationPayload } from './signed';

function key(keyId: string) {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { keyId, privateKey, publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url') };
}

const entry = (over: Partial<RevocationPayload> = {}): RevocationPayload => ({
  revocation_version: 1,
  id: '00000000-0000-7000-8000-000000000001',
  target_type: 'platform',
  target_id: '*',
  action: 'revoke',
  reason: 'Test stop',
  severity: 'critical',
  effective_at: '2026-11-25T10:00:00.000Z',
  ...over,
});

describe('signed revocation entries (SPEC 11.6)', () => {
  const k = key('revocation-test');
  const keys = [{ key_id: k.keyId, public_key: k.publicKey, status: 'active' as const }];
  const signed = (p: RevocationPayload) => ({ signedPayload: revocationCanonical(p), signature: signStatement(REVOCATION_PREFIX, revocationCanonical(p), k) });

  it('verifies a signed entry and reads its signed payload', () => {
    expect(verifiedRevocation(signed(entry()), keys)).toEqual(entry());
  });

  it('refuses a tampered payload, an unknown or revoked key, a missing signature and non-canonical bytes', () => {
    const s = signed(entry());
    expect(verifiedRevocation({ ...s, signedPayload: s.signedPayload.replace('revoke', 'restore') }, keys)).toBeNull();
    expect(verifiedRevocation(s, [{ ...keys[0]!, key_id: 'other' }])).toBeNull();
    expect(verifiedRevocation(s, [{ ...keys[0]!, status: 'revoked' }])).toBeNull();
    expect(verifiedRevocation({ ...s, signature: null }, keys)).toBeNull();
    const loose = JSON.stringify(entry(), null, 1);
    expect(parseRevocationPayload(loose)).toBeNull();
    expect(verifiedRevocation({ signedPayload: loose, signature: signStatement(REVOCATION_PREFIX, loose, k) }, keys)).toBeNull();
  });

  it('a receipt signature is never accepted as a revocation (domain separation)', () => {
    const c = revocationCanonical(entry());
    const asReceipt = signStatement('swarm-explorer-receipt-v1\n', c, k);
    expect(verifyStatement(REVOCATION_PREFIX, c, asReceipt, k.publicKey)).toBe(false);
  });

  it('the newest entry per target decides, and future entries wait', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    const kill = entry();
    const swarm = entry({ id: '2', target_type: 'swarm', target_id: 'challenge-vaults', effective_at: '2026-11-25T10:30:00.000Z' });
    expect(killStateOf([kill, swarm], now)).toEqual({ global: kill, swarms: { 'challenge-vaults': swarm } });
    const lift = entry({ id: '3', action: 'restore', effective_at: '2026-11-25T11:00:00.000Z' });
    expect(killStateOf([kill, swarm, lift], now)).toEqual({ global: null, swarms: { 'challenge-vaults': swarm } });
    const later = entry({ id: '4', effective_at: '2026-11-25T13:00:00.000Z' });
    expect(killStateOf([kill, lift, later], now).global).toBeNull();
    // Other revocation types are not kill switch entries.
    expect(killStateOf([entry({ target_type: 'harness_release', target_id: 'x' })], now)).toEqual({ global: null, swarms: {} });
  });
});

describe('contribution receipts', () => {
  const k = key('receipt-test');
  const unsigned = (over: Partial<UnsignedReceipt> = {}): UnsignedReceipt => ({
    receipt_version: 1,
    receipt_id: '00000000-0000-7000-8000-00000000000a',
    issued_at: '2026-11-25T12:00:00.000Z',
    result: { id: '00000000-0000-7000-8000-00000000000b', state: 'settled', output_sha256: `sha256-${'a'.repeat(64)}` },
    swarm: { slug: 'prompt-guard-red-team', funded: false, release_manifest_hash: `sha256-${'b'.repeat(64)}` },
    pins: { harness: { name: 'prompt-guard-red-team', version: '0.1.0', hash: `sha256-${'c'.repeat(64)}` }, model_artifact_hash: `sha256-${'d'.repeat(64)}`, permissions_hash: `sha256-${'e'.repeat(64)}` },
    verification: [{ method: 'machine-check', outcome: 'accepted', verifier_version: 'prompt-guard-replay-v1', verifier_key_id: 'worker-1' }],
    timeline: { submitted_at: '2026-11-25T11:00:00.000Z', pending_at: '2026-11-25T11:01:00.000Z', settled_at: '2026-11-25T11:59:00.000Z' },
    earned: { impact_units: 1, credits: null },
    contributor: { account_id: '00000000-0000-7000-8000-00000000000c' },
    signer: { key_id: k.keyId, public_key: k.publicKey },
    ...over,
  });
  const trusted = [{ key_id: k.keyId, public_key: k.publicKey, status: 'active' as const }];

  it('signs over the canonical receipt and verifies offline, with or without trusted keys', () => {
    const r = signReceipt(unsigned(), k);
    expect(receiptMessage(unsigned())).toBe(canonicalJson(unsigned()));
    expect(verifyReceipt(r)).toMatchObject({ ok: true, keyId: 'receipt-test', keyTrusted: null });
    expect(verifyReceipt(JSON.parse(JSON.stringify(r)), trusted)).toMatchObject({ ok: true, keyTrusted: true });
  });

  it('refuses any edit, a foreign key and a revoked key', () => {
    const r = signReceipt(unsigned(), k);
    expect(verifyReceipt({ ...r, earned: { impact_units: 5, credits: null } })).toMatchObject({ ok: false, reason: 'bad_signature' });
    const other = key('receipt-test');
    const forged = signReceipt(unsigned({ signer: { key_id: 'receipt-test', public_key: other.publicKey } }), other);
    expect(verifyReceipt(forged)).toMatchObject({ ok: true, keyTrusted: null }); // Intact, but not the platform's.
    expect(verifyReceipt(forged, trusted)).toMatchObject({ ok: false, reason: 'untrusted_key' });
    expect(verifyReceipt(r, [{ ...trusted[0]!, status: 'revoked' }])).toMatchObject({ ok: false, reason: 'revoked_key' });
  });

  it('a volunteer receipt can never carry credits, and unknown fields are refused', () => {
    const credits = signReceipt(unsigned({ earned: { impact_units: 1, credits: 12 } }), k);
    expect(verifyReceipt(credits)).toMatchObject({ ok: false, reason: 'schema' });
    const funded = signReceipt(unsigned({ swarm: { ...unsigned().swarm, funded: true }, earned: { impact_units: 1, credits: 12 } }), k);
    expect(verifyReceipt(funded)).toMatchObject({ ok: true });
    expect(verifyReceipt({ ...signReceipt(unsigned(), k), extra: 1 })).toMatchObject({ ok: false, reason: 'schema' });
    expect(verifyReceipt('nope')).toMatchObject({ ok: false, reason: 'malformed' });
  });
});
