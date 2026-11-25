import { createHash, createPublicKey, verify } from 'node:crypto';
import { refreshProofMessage } from '@swarm-explorer/api-client';
import { describe, expect, it } from 'vitest';
import { AuthManager } from './auth';
import { MemoryStore } from './secrets';

const INSTALL = '01936f3e-0000-7000-8000-0000000000aa';

/** A fake API: checks PKCE and the device proof like the real one, and counts refreshes. */
function fakeServer() {
  const s = { challenge: '', devicePub: '', refreshes: 0, revoked: false, refreshOk: true };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body ?? ''));
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (url.pathname === '/v1/oauth/token' && body.get('grant_type') === 'authorization_code') {
      const ok = createHash('sha256').update(body.get('code_verifier')!).digest('base64url') === s.challenge && body.get('code') === 'the-code-1234567890abc';
      s.devicePub = body.get('device_pubkey')!;
      return ok
        ? json(200, { access_token: 'sxa_first', token_type: 'Bearer', expires_in: 900, refresh_token: 'sxr_first_aaaaaaaaaaaaaaaaaaaa', install_id: INSTALL })
        : json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
    }
    if (url.pathname === '/v1/oauth/token' && body.get('grant_type') === 'refresh_token') {
      s.refreshes++;
      const key = createPublicKey({ key: Buffer.from(s.devicePub, 'base64url'), format: 'der', type: 'spki' });
      const sigOk = verify(null, Buffer.from(refreshProofMessage(body.get('install_id')!, Number(body.get('device_ts')))), key, Buffer.from(body.get('device_sig')!, 'base64url'));
      if (!sigOk || !s.refreshOk) return json(400, { error: 'invalid_grant', error_description: 'Refresh token reuse detected.' });
      return json(200, { access_token: `sxa_r${s.refreshes}`, token_type: 'Bearer', expires_in: 900, refresh_token: `sxr_r${s.refreshes}_bbbbbbbbbbbbbbbbbbbb`, install_id: INSTALL });
    }
    if (url.pathname === '/v1/oauth/revoke') {
      s.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/v1/me') {
      const auth = new Headers(init?.headers).get('authorization');
      return auth === 'Bearer sxa_first' ? json(401, {}) : json(200, { ok: auth });
    }
    return json(404, {});
  };
  return { s, fetchImpl };
}

/** Plays the browser: reads the authorize URL and calls the loopback redirect. */
function browser(s: { challenge: string }, opts: { state?: string; deny?: boolean } = {}) {
  return async (url: string) => {
    const u = new URL(url);
    s.challenge = u.searchParams.get('code_challenge')!;
    const back = new URL(u.searchParams.get('redirect_uri')!);
    expect(back.hostname).toBe('127.0.0.1');
    back.searchParams.set('state', opts.state ?? u.searchParams.get('state')!);
    if (opts.deny) back.searchParams.set('error', 'access_denied');
    else back.searchParams.set('code', 'the-code-1234567890abc');
    setTimeout(() => void fetch(back).catch(() => undefined), 5);
  };
}

const device = { platform: 'darwin', arch: 'arm64', version: '0.1.0', channel: 'dev' as const };

describe('AuthManager', () => {
  it('signs in through the loopback redirect and keeps only the refresh token in the keychain', async () => {
    const { s, fetchImpl } = fakeServer();
    const secrets = new MemoryStore();
    const auth = new AuthManager({ apiBaseUrl: 'http://api.test', secrets, device, fetch: fetchImpl, openBrowser: browser(s) });
    await auth.signIn();
    expect(auth.getState().status).toBe('signed_in');
    const saved = JSON.parse(secrets.map.get('session')!);
    expect(saved).toEqual({ installId: INSTALL, refreshToken: 'sxr_first_aaaaaaaaaaaaaaaaaaaa' });
    expect(JSON.stringify([...secrets.map])).not.toContain('sxa_first');
    expect(secrets.map.get('device-key')).toContain('PRIVATE KEY');
  });

  it('ignores a callback with the wrong state, then times out cleanly on cancel', async () => {
    const { s, fetchImpl } = fakeServer();
    const auth = new AuthManager({ apiBaseUrl: 'http://api.test', secrets: new MemoryStore(), device, fetch: fetchImpl, openBrowser: browser(s, { state: 'attacker-state-value-123' }) });
    const p = auth.signIn();
    setTimeout(() => void auth.signOut(), 100);
    await expect(p).rejects.toThrow('Signed out.');
    expect(auth.getState().status).toBe('signed_out');
  });

  it('reports a denied consent', async () => {
    const { s, fetchImpl } = fakeServer();
    const auth = new AuthManager({ apiBaseUrl: 'http://api.test', secrets: new MemoryStore(), device, fetch: fetchImpl, openBrowser: browser(s, { deny: true }) });
    await expect(auth.signIn()).rejects.toThrow('Sign in was canceled.');
  });

  it('refreshes on 401 with a device-signed proof, single flight', async () => {
    const { s, fetchImpl } = fakeServer();
    const secrets = new MemoryStore();
    const auth = new AuthManager({ apiBaseUrl: 'http://api.test', secrets, device, fetch: fetchImpl, openBrowser: browser(s) });
    await auth.signIn();
    const a = await auth.authedFetch('/v1/me');
    // A second request racing the first 401 must reuse the new token, not refresh again.
    const b = await auth.authedFetch('/v1/me');
    await auth.getAccessToken('sxa_first');
    expect(await a.json()).toEqual({ ok: 'Bearer sxa_r1' });
    expect(await b.json()).toEqual({ ok: 'Bearer sxa_r1' });
    expect(s.refreshes).toBe(1);
    expect(JSON.parse(secrets.map.get('session')!).refreshToken).toBe('sxr_r1_bbbbbbbbbbbbbbbbbbbb');
  });

  it('signs out locally when the server refuses a refresh', async () => {
    const { s, fetchImpl } = fakeServer();
    const secrets = new MemoryStore();
    const auth = new AuthManager({ apiBaseUrl: 'http://api.test', secrets, device, fetch: fetchImpl, openBrowser: browser(s) });
    await auth.signIn();
    s.refreshOk = false;
    expect(await auth.getAccessToken('sxa_first')).toBeNull();
    expect(auth.getState()).toEqual({ status: 'signed_out', error: 'Refresh token reuse detected.' });
    expect(secrets.map.has('session')).toBe(false);
  });

  it('restores a saved session and revokes on sign out', async () => {
    const { s, fetchImpl } = fakeServer();
    const secrets = new MemoryStore();
    await secrets.set('session', JSON.stringify({ installId: INSTALL, refreshToken: 'sxr_saved_cccccccccccccccccccc' }));
    const auth = new AuthManager({ apiBaseUrl: 'http://api.test', secrets, device, fetch: fetchImpl, openBrowser: browser(s) });
    await auth.init();
    expect(auth.getState().status).toBe('signed_in');
    await auth.signOut();
    expect(s.revoked).toBe(true);
    expect(secrets.map.size).toBe(0);
  });
});
