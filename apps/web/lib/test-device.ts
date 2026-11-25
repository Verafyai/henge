/** Test helpers: sign in a seeded user with a fresh device key, and sign node requests. Tests only. */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { DESKTOP_CLIENT_ID, DEVICE_HEADERS, deviceRequestMessage } from '@swarm-explorer/api-client';
import { accounts, getDb } from '@swarm-explorer/db';
import { eq } from 'drizzle-orm';
import { exchangeCode, issueCode } from './auth/oauth';
import { s256 } from './auth/tokens';

const REDIRECT = 'http://127.0.0.1:53117/callback';
export type Device = { pub: string; privateKey: KeyObject; token: string; installId: string };

export async function signIn(handle: string): Promise<Device> {
  const db = await getDb();
  const [a] = await db.select().from(accounts).where(eq(accounts.handle, handle));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const code = await issueCode({ clientId: DESKTOP_CLIENT_ID, accountId: a!.id, redirectUri: REDIRECT, codeChallenge: s256(verifier) });
  const res = await exchangeCode({
    grant_type: 'authorization_code', client_id: DESKTOP_CLIENT_ID, code, code_verifier: verifier, redirect_uri: REDIRECT,
    device_platform: 'darwin', device_arch: 'arm64', app_version: '0.1.0', channel: 'dev', device_pubkey: pub,
  });
  if (!res.ok) throw new Error(res.err.error_description);
  return { pub, privateKey, token: res.tokens.access_token, installId: res.tokens.install_id };
}

export function signed(d: Device, method: string, path: string, body: string, over: { ts?: number; nonce?: string; key?: KeyObject; idem?: string | null } = {}) {
  const ts = over.ts ?? Date.now();
  const nonce = over.nonce ?? randomBytes(16).toString('base64url');
  const msg = deviceRequestMessage({ method, path, bodySha256: createHash('sha256').update(body).digest('base64url'), ts, nonce });
  const headers: Record<string, string> = {
    authorization: `Bearer ${d.token}`,
    'content-type': 'application/json',
    [DEVICE_HEADERS.ts]: String(ts),
    [DEVICE_HEADERS.nonce]: nonce,
    [DEVICE_HEADERS.signature]: sign(null, Buffer.from(msg), over.key ?? d.privateKey).toString('base64url'),
  };
  if (over.idem !== null) headers['idempotency-key'] = over.idem ?? randomBytes(16).toString('base64url');
  return new Request(`http://localhost${path}`, { method, headers, body: method === "GET" ? undefined : body });
}

