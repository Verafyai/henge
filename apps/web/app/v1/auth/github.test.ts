import { accountIdentities, accounts, getDb } from '@swarm-explorer/db';
import { runMigrations, seed } from '@swarm-explorer/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// A minimal cookie jar standing in for next/headers, so createSession can run outside Next.
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: (k: string, v: string) => jar.set(k, v), get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined) }),
  headers: async () => new Headers({ 'x-forwarded-proto': 'https' }),
}));

const { GITHUB_ALLOWLIST, STATE_COOKIE, allowedGithubUser, encodeStateCookie, githubSignInEnabled } = await import('@/lib/auth/github');
const { GET: start } = await import('./github/route');
const { GET: callback } = await import('./github/callback/route');

beforeAll(async () => {
  await runMigrations();
  await seed();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  jar.clear();
});

function configure() {
  vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'test-client');
  vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', 'test-secret');
}

/** Fakes GitHub's token and user endpoints. */
function fakeGithub(user: { id: number; login: string; name?: string | null }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gho_test' });
    if (url === 'https://api.github.com/user') return Response.json({ name: null, ...user });
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

const callbackReq = (state: string, cookieState = state, next = '/swarms') =>
  new Request(`https://staging.test/v1/auth/github/callback?code=abc&state=${state}`, {
    headers: { cookie: `${STATE_COOKIE}=${encodeStateCookie(cookieState, next)}`, host: 'staging.test', 'x-forwarded-proto': 'https' },
  });

describe('GitHub sign in for staging', () => {
  it('is off without the OAuth app keys', async () => {
    expect(githubSignInEnabled()).toBe(false);
    expect((await start(new Request('https://staging.test/v1/auth/github'))).status).toBe(404);
    expect((await callback(callbackReq('s'))).status).toBe(404);
  });

  it('pins exactly the two approved accounts by GitHub id', () => {
    expect(GITHUB_ALLOWLIST.map((a) => a.login)).toEqual(['rexsaurus', 'Verafyai']);
    expect(allowedGithubUser(77756242)).toBe(true);
    expect(allowedGithubUser(1)).toBe(false);
  });

  it('starts with a state cookie and no sign-up', async () => {
    configure();
    const res = await start(new Request('https://staging.test/v1/auth/github?next=/swarms', { headers: { host: 'staging.test', 'x-forwarded-proto': 'https' } }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://staging.test/v1/auth/github/callback');
    expect(loc.searchParams.get('allow_signup')).toBe('false');
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  });

  it('refuses a mismatched state before calling GitHub', async () => {
    configure();
    const calls = fakeGithub({ id: 77756242, login: 'rexsaurus' });
    const res = await callback(callbackReq('aaaa', 'bbbb'));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses a GitHub account that is not on the allowlist, with no account or session', async () => {
    configure();
    fakeGithub({ id: 424242, login: 'someone-else' });
    const res = await callback(callbackReq('s1'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('not_allowed');
    const db = await getDb();
    expect(await db.select().from(accounts).where(eq(accounts.handle, 'someone-else'))).toEqual([]);
    expect(jar.size).toBe(0);
  });

  it('signs in an allowlisted account, links it once, and redirects to next', async () => {
    configure();
    fakeGithub({ id: 197112695, login: 'Verafyai', name: 'Verafy' });
    const first = await callback(callbackReq('s2'));
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('/swarms');
    expect([...jar.keys()]).toEqual(['__Host-ss_session']);
    const again = await callback(callbackReq('s3'));
    expect(again.status).toBe(303);
    const db = await getDb();
    const links = await db
      .select()
      .from(accountIdentities)
      .where(and(eq(accountIdentities.provider, 'github'), eq(accountIdentities.providerSubject, '197112695')));
    expect(links).toHaveLength(1);
  });
});

describe('example-account sign in', () => {
  it('stays off on every Vercel deployment, even with DEV_SIGN_IN=1', async () => {
    const { devSignInEnabled } = await import('@/lib/auth/session');
    vi.stubEnv('DEV_SIGN_IN', '1');
    for (const env of ['preview', 'production', 'development']) {
      vi.stubEnv('VERCEL_ENV', env);
      expect(devSignInEnabled()).toBe(false);
    }
    vi.unstubAllEnvs();
    vi.stubEnv('DEV_SIGN_IN', '1');
    vi.stubEnv('VERCEL', '1');
    expect(devSignInEnabled()).toBe(false);
  });
});
