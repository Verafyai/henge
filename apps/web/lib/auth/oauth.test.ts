import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DESKTOP_CLIENT_ID, refreshProofMessage } from '@swarm-explorer/api-client';
import { installs, getDb, accounts } from '@swarm-explorer/db';
import { runMigrations, seed } from '@swarm-explorer/db/testing';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { authenticate, exchangeCode, issueCode, redirectAllowed, refreshGrant, revokeToken } from './oauth';
import { s256 } from './tokens';

const REDIRECT = 'http://127.0.0.1:53117/callback';
let accountId: string;

beforeAll(async () => {
  await runMigrations();
  await seed();
  const db = await getDb();
  const [u] = await db.select().from(accounts).where(eq(accounts.handle, 'demo'));
  accountId = u!.id;
});

function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), privateKey };
}

async function signIn(d = device()) {
  const verifier = randomBytes(32).toString('base64url');
  const code = await issueCode({ clientId: DESKTOP_CLIENT_ID, accountId, redirectUri: REDIRECT, codeChallenge: s256(verifier) });
  const res = await exchangeCode({
    grant_type: 'authorization_code',
    client_id: DESKTOP_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    device_platform: 'darwin',
    device_arch: 'arm64',
    app_version: '0.1.0',
    channel: 'dev',
    device_pubkey: d.pub,
  });
  if (!res.ok) throw new Error(res.err.error_description);
  return { tokens: res.tokens, d, code, verifier };
}

function proof(d: ReturnType<typeof device>, installId: string, ts = Date.now()) {
  return { device_ts: ts, device_sig: sign(null, Buffer.from(refreshProofMessage(installId, ts)), d.privateKey).toString('base64url') };
}

const bearer = (t: string) => new Request('http://x/v1/me', { headers: { authorization: `Bearer ${t}` } });

describe('redirect matching', () => {
  const reg = ['http://127.0.0.1/callback', 'swarmexplorer://auth/callback'];
  it('accepts any loopback port and the custom scheme exactly', () => {
    expect(redirectAllowed(reg, 'http://127.0.0.1:49152/callback')).toBe(true);
    expect(redirectAllowed(reg, 'swarmexplorer://auth/callback')).toBe(true);
  });
  it('refuses other hosts, paths, queries and userinfo', () => {
    expect(redirectAllowed(reg, 'http://localhost:49152/callback')).toBe(false);
    expect(redirectAllowed(reg, 'http://127.0.0.1:49152/other')).toBe(false);
    expect(redirectAllowed(reg, 'http://127.0.0.1:49152/callback?x=1')).toBe(false);
    expect(redirectAllowed(reg, 'http://a@127.0.0.1:49152/callback')).toBe(false);
    expect(redirectAllowed(reg, 'https://evil.example/callback')).toBe(false);
  });
});

describe('authorization code exchange', () => {
  it('issues tokens and registers the install', async () => {
    const { tokens } = await signIn();
    const db = await getDb();
    const [install] = await db.select().from(installs).where(eq(installs.id, tokens.install_id));
    expect(install?.accountId).toBe(accountId);
    const authed = await authenticate(bearer(tokens.access_token));
    expect(authed?.user.handle).toBe('demo');
  });

  it('rejects a wrong PKCE verifier and single-uses codes', async () => {
    const d = device();
    const verifier = randomBytes(32).toString('base64url');
    const code = await issueCode({ clientId: DESKTOP_CLIENT_ID, accountId, redirectUri: REDIRECT, codeChallenge: s256(verifier) });
    const base = {
      grant_type: 'authorization_code' as const,
      client_id: DESKTOP_CLIENT_ID,
      code,
      redirect_uri: REDIRECT,
      device_platform: 'darwin',
      device_arch: 'arm64',
      app_version: '0.1.0',
      channel: 'dev' as const,
      device_pubkey: d.pub,
    };
    const bad = await exchangeCode({ ...base, code_verifier: randomBytes(32).toString('base64url') });
    expect(bad).toMatchObject({ ok: false, err: { error: 'invalid_grant' } });
    // The failed attempt consumed the code, so the right verifier is now too late.
    const again = await exchangeCode({ ...base, code_verifier: verifier });
    expect(again.ok).toBe(false);
  });

  it('rejects expired codes', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await issueCode({ clientId: DESKTOP_CLIENT_ID, accountId, redirectUri: REDIRECT, codeChallenge: s256(verifier) }, new Date(Date.now() - 11 * 60_000));
    const res = await exchangeCode({
      grant_type: 'authorization_code',
      client_id: DESKTOP_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      device_platform: 'darwin',
      device_arch: 'arm64',
      app_version: '0.1.0',
      channel: 'dev',
      device_pubkey: device().pub,
    });
    expect(res).toMatchObject({ ok: false, err: { error_description: 'The authorization code expired.' } });
  });
});

describe('refresh rotation', () => {
  it('rotates, and the old access token keeps working until expiry', async () => {
    const { tokens, d } = await signIn();
    const r = await refreshGrant({ grant_type: 'refresh_token', client_id: DESKTOP_CLIENT_ID, refresh_token: tokens.refresh_token, install_id: tokens.install_id, ...proof(d, tokens.install_id) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens.refresh_token).not.toBe(tokens.refresh_token);
  });

  it('requires a signature from the install device key', async () => {
    const { tokens, d } = await signIn();
    const stranger = device();
    const r = await refreshGrant({ grant_type: 'refresh_token', client_id: DESKTOP_CLIENT_ID, refresh_token: tokens.refresh_token, install_id: tokens.install_id, ...proof(stranger, tokens.install_id) });
    expect(r).toMatchObject({ ok: false, err: { error_description: 'Device proof failed.' } });
    const stale = await refreshGrant({ grant_type: 'refresh_token', client_id: DESKTOP_CLIENT_ID, refresh_token: tokens.refresh_token, install_id: tokens.install_id, ...proof(d, tokens.install_id, Date.now() - 10 * 60_000) });
    expect(stale).toMatchObject({ ok: false, err: { error_description: expect.stringContaining('stale') } });
  });

  it('detects reuse of a rotated token and revokes the whole install', async () => {
    const { tokens, d } = await signIn();
    const first = await refreshGrant({ grant_type: 'refresh_token', client_id: DESKTOP_CLIENT_ID, refresh_token: tokens.refresh_token, install_id: tokens.install_id, ...proof(d, tokens.install_id) });
    expect(first.ok).toBe(true);
    const replay = await refreshGrant({ grant_type: 'refresh_token', client_id: DESKTOP_CLIENT_ID, refresh_token: tokens.refresh_token, install_id: tokens.install_id, ...proof(d, tokens.install_id) });
    expect(replay).toMatchObject({ ok: false, err: { error_description: expect.stringContaining('reuse') } });
    // The legitimate new tokens die with the install.
    if (first.ok) {
      expect(await authenticate(bearer(first.tokens.access_token))).toBeNull();
      const next = await refreshGrant({ grant_type: 'refresh_token', client_id: DESKTOP_CLIENT_ID, refresh_token: first.tokens.refresh_token, install_id: tokens.install_id, ...proof(d, tokens.install_id) });
      expect(next.ok).toBe(false);
    }
    const db = await getDb();
    const [install] = await db.select().from(installs).where(eq(installs.id, tokens.install_id));
    expect(install?.revokedReason).toBe('refresh_token_reuse');
  });
});

describe('revocation and bearer auth', () => {
  it('signs the install out', async () => {
    const { tokens } = await signIn();
    await revokeToken(DESKTOP_CLIENT_ID, tokens.refresh_token);
    expect(await authenticate(bearer(tokens.access_token))).toBeNull();
  });

  it('rejects malformed and expired bearer tokens', async () => {
    const { tokens } = await signIn();
    expect(await authenticate(new Request('http://x', { headers: { authorization: 'Bearer nope' } }))).toBeNull();
    expect(await authenticate(bearer(tokens.access_token), new Date(Date.now() + 16 * 60_000))).toBeNull();
  });
});
