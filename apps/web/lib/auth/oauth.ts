/**
 * OAuth 2.0 Authorization Code + PKCE for the desktop client (ADDENDUM A3.1),
 * with refresh rotation bound to a client install and its device key, and
 * reuse detection that revokes the install.
 */
import { createPublicKey, verify } from 'node:crypto';
import {
  ACCESS_TOKEN_TTL_S,
  refreshProofMessage,
  type TokenResponse,
} from '@swarm-explorer/api-client';
import type { codeGrantSchema, refreshGrantSchema } from '@swarm-explorer/api-client';
import { accessTokens, installs, getDb, oauthClients, oauthCodes, refreshTokens, accounts, type Install } from '@swarm-explorer/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { hashToken, newToken, s256 } from './tokens';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_PROOF_SKEW_MS = 5 * 60 * 1000;

export type OAuthError = { error: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type'; error_description: string };
const fail = (error: OAuthError['error'], error_description: string): { ok: false; err: OAuthError } => ({ ok: false, err: { error, error_description } });

export async function findClient(id: string) {
  const db = await getDb();
  const [c] = await db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1);
  return c ?? null;
}

/**
 * Exact match, except registered loopback URIs, which accept any port
 * (RFC 8252 section 7.3). Never matches query strings, fragments or userinfo.
 */
export function redirectAllowed(registered: string[], candidate: string): boolean {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  return registered.some((r) => {
    const reg = new URL(r);
    if (reg.protocol === 'http:' && reg.hostname === '127.0.0.1') {
      return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.pathname === reg.pathname && (u.port === '' || /^\d{1,5}$/.test(u.port));
    }
    return candidate === r;
  });
}

export async function issueCode(p: { clientId: string; accountId: string; redirectUri: string; codeChallenge: string }, now = new Date()): Promise<string> {
  const db = await getDb();
  const code = newToken('sxc');
  await db.insert(oauthCodes).values({
    codeHash: hashToken(code),
    clientId: p.clientId,
    accountId: p.accountId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  });
  return code;
}

function parseDeviceKey(b64u: string) {
  try {
    const key = createPublicKey({ key: Buffer.from(b64u, 'base64url'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

async function issueTokens(install: Pick<Install, 'id' | 'accountId'>, parentId: string | null, now: Date): Promise<TokenResponse> {
  const db = await getDb();
  const access = newToken('sxa');
  const refresh = newToken('sxr');
  await db.insert(accessTokens).values({
    tokenHash: hashToken(access),
    installId: install.id,
    accountId: install.accountId,
    expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_S * 1000),
  });
  await db.insert(refreshTokens).values({ installId: install.id, tokenHash: hashToken(refresh), parentId });
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, install_id: install.id };
}

type Result = { ok: true; tokens: TokenResponse } | { ok: false; err: OAuthError };

export async function exchangeCode(req: z.infer<typeof codeGrantSchema>, now = new Date()): Promise<Result> {
  const db = await getDb();
  const client = await findClient(req.client_id);
  if (!client) return fail('invalid_client', 'Unknown client.');
  const devicePublicKey = parseDeviceKey(req.device_pubkey);
  if (!devicePublicKey) return fail('invalid_request', 'device_pubkey must be an Ed25519 public key.');

  // Consume the code atomically: a second exchange finds nothing to update.
  const [code] = await db
    .update(oauthCodes)
    .set({ usedAt: now })
    .where(and(eq(oauthCodes.codeHash, hashToken(req.code)), isNull(oauthCodes.usedAt)))
    .returning();
  if (!code) return fail('invalid_grant', 'The authorization code is invalid or already used.');
  if (code.expiresAt <= now) return fail('invalid_grant', 'The authorization code expired.');
  if (code.clientId !== client.id || code.redirectUri !== req.redirect_uri) return fail('invalid_grant', 'Client or redirect does not match.');
  if (s256(req.code_verifier) !== code.codeChallenge) return fail('invalid_grant', 'PKCE verification failed.');

  const [install] = await db
    .insert(installs)
    .values({
      accountId: code.accountId,
      clientId: client.id,
      platform: req.device_platform,
      arch: req.device_arch,
      clientVersion: req.app_version,
      channel: req.channel,
      devicePublicKey: req.device_pubkey,
    })
    .returning();
  return { ok: true, tokens: await issueTokens(install!, null, now) };
}

export async function revokeInstall(installId: string, reason: string, now = new Date()) {
  const db = await getDb();
  await db.update(installs).set({ revokedAt: now, revokedReason: reason }).where(and(eq(installs.id, installId), isNull(installs.revokedAt)));
  await db.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.installId, installId), isNull(refreshTokens.revokedAt)));
  await db.delete(accessTokens).where(eq(accessTokens.installId, installId));
}

export async function refreshGrant(req: z.infer<typeof refreshGrantSchema>, now = new Date()): Promise<Result> {
  const db = await getDb();
  const [install] = await db.select().from(installs).where(eq(installs.id, req.install_id)).limit(1);
  if (!install || install.clientId !== req.client_id) return fail('invalid_grant', 'Unknown install.');
  if (install.revokedAt) return fail('invalid_grant', 'This install was signed out. Sign in again.');

  // Proof of possession of the device key bound at sign in.
  if (Math.abs(now.getTime() - req.device_ts) > DEVICE_PROOF_SKEW_MS) return fail('invalid_grant', 'Device proof is stale. Check the system clock.');
  const key = parseDeviceKey(install.devicePublicKey);
  const sigOk = key !== null && verify(null, Buffer.from(refreshProofMessage(install.id, req.device_ts)), key, Buffer.from(req.device_sig, 'base64url'));
  if (!sigOk) return fail('invalid_grant', 'Device proof failed.');

  const hash = hashToken(req.refresh_token);
  const [token] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
  if (!token || token.installId !== install.id) return fail('invalid_grant', 'Unknown refresh token.');

  const [claimed] = token.usedAt || token.revokedAt
    ? []
    : await db
        .update(refreshTokens)
        .set({ usedAt: now })
        .where(and(eq(refreshTokens.id, token.id), isNull(refreshTokens.usedAt), isNull(refreshTokens.revokedAt)))
        .returning();
  if (!claimed) {
    // A rotated token came back: someone holds a copy. Kill the whole install.
    await revokeInstall(install.id, 'refresh_token_reuse', now);
    return fail('invalid_grant', 'Refresh token reuse detected. This install was signed out.');
  }
  await db.update(installs).set({ lastSeenAt: now }).where(eq(installs.id, install.id));
  return { ok: true, tokens: await issueTokens(install, claimed.id, now) };
}

/** RFC 7009. Revoking any token of an install signs that install out. Unknown tokens are not an error. */
export async function revokeToken(clientId: string, raw: string, now = new Date()): Promise<void> {
  const db = await getDb();
  const hash = hashToken(raw);
  const [r] = await db.select({ installId: refreshTokens.installId }).from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
  const [a] = r ? [] : await db.select({ installId: accessTokens.installId }).from(accessTokens).where(eq(accessTokens.tokenHash, hash)).limit(1);
  const installId = r?.installId ?? a?.installId;
  if (!installId) return;
  const [install] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
  if (install?.clientId === clientId) await revokeInstall(installId, 'signed_out', now);
}

export type Authed = { user: typeof accounts.$inferSelect; install: Install };

/** Bearer authentication for client endpoints. Cookies are ignored here on purpose (A7.1). */
export async function authenticate(req: Request, now = new Date()): Promise<Authed | null> {
  const m = /^Bearer (sxa_[A-Za-z0-9_-]{43})$/.exec(req.headers.get('authorization') ?? '');
  if (!m) return null;
  const db = await getDb();
  const [row] = await db
    .select({ t: accessTokens, install: installs, user: accounts })
    .from(accessTokens)
    .innerJoin(installs, eq(installs.id, accessTokens.installId))
    .innerJoin(accounts, eq(accounts.id, accessTokens.accountId))
    .where(eq(accessTokens.tokenHash, hashToken(m[1]!)))
    .limit(1);
  if (!row || row.t.expiresAt <= now || row.install.revokedAt || row.user.suspendedAt) return null;
  return { user: row.user, install: row.install };
}
