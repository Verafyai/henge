/**
 * GitHub sign in for staging (Rex, 2026-11-25): one real identity provider, and only an allowlist of two GitHub
 * accounts gets in. Example-account sign in stays off on every reachable URL.
 *
 * Off unless GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are both set. The allowlist is pinned by GitHub's
 * numeric user id, because a login can be renamed and then claimed by someone else.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { accountIdentities, accounts, getDb } from '@swarm-explorer/db';
import { and, eq, sql } from 'drizzle-orm';

export const GITHUB_ALLOWLIST: ReadonlyArray<{ id: number; login: string }> = [
  { id: 77756242, login: 'rexsaurus' },
  { id: 197112695, login: 'Verafyai' },
];

export const STATE_COOKIE = 'gh_oauth_state';
export const STATE_TTL_S = 600;

export function githubCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function githubSignInEnabled(): boolean {
  return githubCredentials() !== null;
}

export function allowedGithubUser(id: number): boolean {
  return GITHUB_ALLOWLIST.some((a) => a.id === id);
}

/** The callback URL GitHub redirects to. It must equal the one registered on the OAuth app. */
export function callbackUrl(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  return `${proto}://${host}/v1/auth/github/callback`;
}

/** State is random, kept in an httpOnly cookie with the post-sign-in path, and compared in constant time. */
export function newState(): string {
  return randomBytes(24).toString('base64url');
}

export function encodeStateCookie(state: string, next: string): string {
  return Buffer.from(JSON.stringify({ state, next })).toString('base64url');
}

export function readStateCookie(value: string | undefined): { state: string; next: string } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { state?: unknown; next?: unknown };
    return typeof v.state === 'string' && typeof v.next === 'string' ? { state: v.state, next: v.next } : null;
  } catch {
    return null;
  }
}

export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export type GithubUser = { id: number; login: string; name: string | null };

/** Exchanges the code and reads the user. The access token is used once here and never stored. */
export async function fetchGithubUser(code: string, redirectUri: string, f: typeof fetch = fetch): Promise<GithubUser | null> {
  const creds = githubCredentials();
  if (!creds) return null;
  const tokenRes = await f('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!tokenRes.ok) return null;
  const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!token) return null;
  const userRes = await f('https://api.github.com/user', {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'henge-web' },
  });
  if (!userRes.ok) return null;
  const u = (await userRes.json()) as { id?: unknown; login?: unknown; name?: unknown };
  return typeof u.id === 'number' && typeof u.login === 'string' ? { id: u.id, login: u.login, name: typeof u.name === 'string' ? u.name : null } : null;
}

/** Finds the account linked to this GitHub id, or creates one. Only ever called for allowlisted ids. */
export async function accountForGithubUser(user: GithubUser): Promise<string> {
  const db = await getDb();
  const subject = String(user.id);
  const [linked] = await db
    .select({ accountId: accountIdentities.accountId })
    .from(accountIdentities)
    .where(and(eq(accountIdentities.provider, 'github'), eq(accountIdentities.providerSubject, subject)))
    .limit(1);
  if (linked) return linked.accountId;
  return db.transaction(async (tx) => {
    let handle = user.login;
    const [taken] = await tx.select({ id: accounts.id }).from(accounts).where(sql`lower(${accounts.handle}) = lower(${handle})`).limit(1);
    if (taken) handle = `${user.login}-github`;
    const [acct] = await tx.insert(accounts).values({ handle, displayName: user.name ?? user.login }).returning({ id: accounts.id });
    await tx.insert(accountIdentities).values({ accountId: acct!.id, provider: 'github', providerSubject: subject, verifiedAt: new Date() });
    return acct!.id;
  });
}
