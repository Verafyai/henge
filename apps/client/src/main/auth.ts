/**
 * Desktop sign in (ADDENDUM A3.1): OAuth 2.0 Authorization Code with PKCE in
 * the system browser, loopback redirect on 127.0.0.1 with a random port, and
 * swarmexplorer://auth/callback as the fallback. The refresh token and device
 * key live in the OS keychain; the access token lives only in memory.
 */
import { EventEmitter } from 'node:events';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { DESKTOP_CLIENT_ID, DEVICE_HEADERS, deviceRequestMessage, oauthErrorSchema, refreshProofMessage, tokenResponseSchema, type TokenResponse } from '@swarm-explorer/api-client';
import { z } from 'zod';
import type { SecretStore } from './secrets';

export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
export const FALLBACK_REDIRECT = 'swarmexplorer://auth/callback';

const sessionSchema = z.object({ installId: z.uuid(), refreshToken: z.string().min(20) });
type Session = z.infer<typeof sessionSchema>;

export type DeviceInfo = { platform: string; arch: string; version: string; channel: 'stable' | 'beta' | 'internal' | 'dev' };
export type AuthState = { status: 'signed_out' | 'signing_in' | 'signed_in'; error?: string };

export class AuthError extends Error {}

const b64u = (b: Buffer) => b.toString('base64url');

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Swarm Explorer</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:6rem auto;padding:0 1rem;color:#09090b">
<h1 style="font-size:1.5rem">You are signed in</h1><p style="color:#52525b">You can close this tab and return to Swarm Explorer.</p></body>`;
const CALLBACK_FAIL_PAGE = CALLBACK_PAGE.replace('You are signed in', 'Sign in did not finish').replace('You can close this tab and return to Swarm Explorer.', 'Close this tab and try again from the client.');

type Pending = { state: string; verifier: string; redirectUri: string; resolve: (code: string) => void; reject: (e: Error) => void; server?: Server; timer: NodeJS.Timeout };

export class AuthManager extends EventEmitter<{ changed: [AuthState] }> {
  private session: Session | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string | null> | null = null;
  private pending: Pending | null = null;
  private state: AuthState = { status: 'signed_out' };

  constructor(
    private readonly opts: {
      apiBaseUrl: string;
      secrets: SecretStore;
      device: DeviceInfo;
      openBrowser: (url: string) => Promise<void>;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    super();
  }

  private get fetch() {
    return this.opts.fetch ?? fetch;
  }
  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  getState(): AuthState {
    return this.state;
  }

  private setState(s: AuthState) {
    this.state = s;
    this.emit('changed', s);
  }

  /** Restores a saved session from the keychain. */
  async init(): Promise<void> {
    const raw = await this.opts.secrets.get('session');
    const parsed = raw ? sessionSchema.safeParse(JSON.parse(raw)) : null;
    this.session = parsed?.success ? parsed.data : null;
    this.setState({ status: this.session ? 'signed_in' : 'signed_out' });
  }

  get installId(): string | null {
    return this.session?.installId ?? null;
  }

  private async deviceKey() {
    let pem = await this.opts.secrets.get('device-key');
    if (!pem) {
      const { privateKey } = generateKeyPairSync('ed25519');
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      await this.opts.secrets.set('device-key', pem);
    }
    const priv = createPrivateKey(pem);
    return { priv, pub: b64u(createPublicKey(priv).export({ type: 'spki', format: 'der' })) };
  }

  /** Starts the browser flow and resolves once tokens are stored. */
  async signIn(): Promise<void> {
    this.cancelPending('Sign in restarted.');
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(createHash('sha256').update(verifier).digest());
    const state = b64u(randomBytes(24));

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.cancelPending('Sign in timed out. Try again.'), SIGN_IN_TIMEOUT_MS);
      const pending: Pending = { state, verifier, redirectUri: FALLBACK_REDIRECT, resolve, reject, timer };
      this.pending = pending;
      this.setState({ status: 'signing_in' });
      void this.startLoopback(pending)
        .catch(() => undefined) // Loopback unavailable: the custom scheme fallback still works.
        .then(() => {
          const u = new URL('/v1/oauth/authorize', this.opts.apiBaseUrl);
          u.search = new URLSearchParams({
            response_type: 'code',
            client_id: DESKTOP_CLIENT_ID,
            redirect_uri: pending.redirectUri,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
          }).toString();
          return this.opts.openBrowser(u.toString());
        })
        .catch((e: Error) => this.cancelPending(e.message));
    }).catch((e: Error) => {
      this.setState({ status: 'signed_out', error: e.message });
      throw e;
    });

    const pending = this.finishPending();
    const device = await this.deviceKey();
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: DESKTOP_CLIENT_ID,
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      device_platform: this.opts.device.platform,
      device_arch: this.opts.device.arch,
      app_version: this.opts.device.version,
      channel: this.opts.device.channel,
      device_pubkey: device.pub,
    }).catch((e: Error) => {
      this.setState({ status: 'signed_out', error: e.message });
      throw e;
    });
    await this.store(tokens);
    this.setState({ status: 'signed_in' });
  }

  private startLoopback(p: Pending): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'GET' || u.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = this.handleCallbackParams(u.searchParams);
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(ok ? CALLBACK_PAGE : CALLBACK_FAIL_PAGE);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return reject(new Error('no port'));
        p.server = server;
        p.redirectUri = `http://127.0.0.1:${addr.port}/callback`;
        resolve();
      });
    });
  }

  /** Fallback path: swarmexplorer://auth/callback?code=...&state=... from the deep link handler. */
  handleCallbackUrl(url: string): boolean {
    if (!this.pending || this.pending.redirectUri !== FALLBACK_REDIRECT) return false;
    return this.handleCallbackParams(new URL(url).searchParams);
  }

  private handleCallbackParams(sp: URLSearchParams): boolean {
    const p = this.pending;
    const state = sp.get('state');
    if (!p || !state || !sameString(state, p.state)) return false;
    const error = sp.get('error');
    const code = sp.get('code');
    if (error || !code) {
      this.cancelPending(error === 'access_denied' ? 'Sign in was canceled.' : 'Sign in failed.');
      return false;
    }
    p.resolve(code);
    return true;
  }

  private finishPending(): Pending {
    const p = this.pending!;
    clearTimeout(p.timer);
    p.server?.close();
    this.pending = null;
    return p;
  }

  private cancelPending(reason: string) {
    if (!this.pending) return;
    const p = this.finishPending();
    p.reject(new AuthError(reason));
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetch(new URL('/v1/oauth/token', this.opts.apiBaseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = oauthErrorSchema.safeParse(json);
      throw new AuthError(err.success ? (err.data.error_description ?? err.data.error) : `Sign in failed (${res.status}).`);
    }
    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) throw new AuthError('The server sent an unexpected sign in response.');
    return parsed.data;
  }

  private async store(t: TokenResponse) {
    this.session = { installId: t.install_id, refreshToken: t.refresh_token };
    await this.opts.secrets.set('session', JSON.stringify(this.session));
    this.access = { token: t.access_token, expiresAt: this.now() + (t.expires_in - 30) * 1000 };
  }

  /**
   * A valid access token, refreshing (once, shared) when needed. Null when
   * signed out. `rejected` is a token the server just refused: we refresh only
   * if we are still holding that same token, so parallel 401s refresh once.
   */
  async getAccessToken(rejected?: string): Promise<string | null> {
    if (!this.session) return null;
    const fresh = this.access && this.access.expiresAt > this.now();
    if (fresh && this.access!.token !== rejected) return this.access!.token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string | null> {
    const s = this.session;
    if (!s) return null;
    const { priv } = await this.deviceKey();
    const ts = this.now();
    try {
      const t = await this.tokenRequest({
        grant_type: 'refresh_token',
        client_id: DESKTOP_CLIENT_ID,
        refresh_token: s.refreshToken,
        install_id: s.installId,
        device_ts: String(ts),
        device_sig: b64u(sign(null, Buffer.from(refreshProofMessage(s.installId, ts)), priv)),
      });
      await this.store(t);
      return t.access_token;
    } catch (e) {
      if (e instanceof AuthError) {
        // The server refused (revoked, reused or expired). Drop local credentials.
        await this.clearLocal(e.message);
        return null;
      }
      throw e; // Network trouble: keep the session and let the caller show offline.
    }
  }

  /** Fetch with the bearer token; on 401 refreshes once and retries. */
  async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const go = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      headers.set('accept', 'application/json');
      return this.fetch(new URL(path, this.opts.apiBaseUrl), { ...init, headers });
    };
    const token = await this.getAccessToken();
    if (!token) throw new AuthError('Signed out.');
    const res = await go(token);
    if (res.status !== 401) return res;
    const again = await this.getAccessToken(token);
    if (!again) throw new AuthError('Signed out.');
    return go(again);
  }

  /**
   * A node request (SPEC 13): bearer token plus a device signature over method, path, body hash,
   * timestamp and nonce. Each attempt is signed afresh, so the 401 retry never reuses a nonce.
   * Writes carry one Idempotency-Key across attempts.
   */
  async signedFetch(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    const url = new URL(path, this.opts.apiBaseUrl);
    const text = body === undefined ? '' : JSON.stringify(body);
    const idem = method === 'GET' ? null : randomBytes(18).toString('base64url');
    const attempt = async (token: string) => {
      const { priv } = await this.deviceKey();
      const ts = this.now();
      const nonce = randomBytes(18).toString('base64url');
      const msg = deviceRequestMessage({ method, path: `${url.pathname}${url.search}`, bodySha256: b64u(createHash('sha256').update(text).digest()), ts, nonce });
      const headers = new Headers({
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        [DEVICE_HEADERS.ts]: String(ts),
        [DEVICE_HEADERS.nonce]: nonce,
        [DEVICE_HEADERS.signature]: b64u(sign(null, Buffer.from(msg), priv)),
      });
      if (idem) headers.set('idempotency-key', idem);
      if (body !== undefined) headers.set('content-type', 'application/json');
      return this.fetch(url, { method, headers, body: body === undefined ? undefined : text });
    };
    const token = await this.getAccessToken();
    if (!token) throw new AuthError('Signed out.');
    const res = await attempt(token);
    if (res.status !== 401) return res;
    const again = await this.getAccessToken(token);
    if (!again) throw new AuthError('Signed out.');
    return attempt(again);
  }

  async signOut(): Promise<void> {
    const s = this.session;
    if (s) {
      await this.fetch(new URL('/v1/oauth/revoke', this.opts.apiBaseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: DESKTOP_CLIENT_ID, token: s.refreshToken }).toString(),
      }).catch(() => undefined); // Offline sign out still clears this device.
    }
    await this.clearLocal();
  }

  private async clearLocal(error?: string) {
    this.cancelPending('Signed out.');
    this.session = null;
    this.access = null;
    await this.opts.secrets.delete('session');
    // A fresh device key per install: the next sign in registers a new install.
    await this.opts.secrets.delete('device-key');
    this.setState({ status: 'signed_out', error });
  }
}
