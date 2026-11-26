/**
 * Platform signing keys (M7): one for the signed revocation feed (kill switch, SPEC 11.6) and one for
 * contribution receipts. A deployment supplies each private key as PKCS8 DER base64url in
 * `PLATFORM_REVOCATION_KEY` and `PLATFORM_RECEIPT_KEY`. Without them, each server process makes its own
 * key (key ids `revocation-dev-*`, `receipt-dev-*`), which is fine for development and tests: every
 * public half is registered in `platform_keys` before it signs, and old keys stay listed so earlier
 * entries and receipts still verify. Production key custody is not decided (Needs Rex).
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { signingKeyFromPkcs8, type SigningKey } from '@swarm-explorer/verify';
import { asc, eq } from 'drizzle-orm';
import { getDb, type Db } from './client';
import type { Tx } from './ledger';
import { platformKeys } from './schema';

export type PlatformKeyPurpose = 'revocation' | 'receipt';
const ENV: Record<PlatformKeyPurpose, string> = { revocation: 'PLATFORM_REVOCATION_KEY', receipt: 'PLATFORM_RECEIPT_KEY' };

const g = globalThis as unknown as { __platformKeys?: Partial<Record<PlatformKeyPurpose, SigningKey>> };

export function platformSigningKey(purpose: PlatformKeyPurpose): SigningKey {
  g.__platformKeys ??= {};
  const cached = g.__platformKeys[purpose];
  if (cached) return cached;
  const env = process.env[ENV[purpose]];
  const pkcs8 = env || generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
  const probe = signingKeyFromPkcs8('probe', pkcs8);
  const keyId = `${purpose}-${env ? '' : 'dev-'}${createHash('sha256').update(probe.publicKey).digest('hex').slice(0, 16)}`;
  const key = signingKeyFromPkcs8(keyId, pkcs8);
  g.__platformKeys[purpose] = key;
  return key;
}

/** The signing key, registered (idempotently) so its public half is published before it signs. */
export async function registeredPlatformKey(tx: Tx | Db, purpose: PlatformKeyPurpose): Promise<SigningKey> {
  const key = platformSigningKey(purpose);
  await tx.insert(platformKeys).values({ keyId: key.keyId, publicKey: key.publicKey, purpose }).onConflictDoNothing();
  return key;
}

/** Every registered key for a purpose, oldest first, in the wire form nodes and verifiers use. */
export async function listPlatformKeys(purpose: PlatformKeyPurpose) {
  const db = await getDb();
  // Registering here means a fresh deployment publishes its key before anything was signed with it.
  await registeredPlatformKey(db, purpose);
  const rows = await db.select().from(platformKeys).where(eq(platformKeys.purpose, purpose)).orderBy(asc(platformKeys.createdAt));
  return rows.map((r) => ({ key_id: r.keyId, public_key: r.publicKey, status: r.status }));
}
