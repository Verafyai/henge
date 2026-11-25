/**
 * Web sign-in sessions. The web signs in only to hand off to the client and
 * for account essentials (ADDENDUM A2.1); client APIs ignore these cookies.
 */
import { getDb, accounts, webSessions } from '@swarm-explorer/db';
import { eq } from 'drizzle-orm';
import { cookies, headers } from 'next/headers';
import { hashToken, newToken } from './tokens';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

async function cookieName(): Promise<string> {
  const h = await headers();
  return h.get('x-forwarded-proto') === 'https' ? '__Host-ss_session' : 'ss_session';
}

export async function createSession(accountId: string): Promise<void> {
  const raw = newToken('sxs');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const db = await getDb();
  await db.insert(webSessions).values({ tokenHash: hashToken(raw), accountId, expiresAt });
  const name = await cookieName();
  (await cookies()).set(name, raw, { httpOnly: true, sameSite: 'lax', secure: name.startsWith('__Host-'), path: '/', expires: expiresAt });
}

export async function sessionUser() {
  const jar = await cookies();
  const raw = jar.get('__Host-ss_session')?.value ?? jar.get('ss_session')?.value;
  if (!raw) return null;
  const db = await getDb();
  const [row] = await db
    .select({ s: webSessions, u: accounts })
    .from(webSessions)
    .innerJoin(accounts, eq(accounts.id, webSessions.accountId))
    .where(eq(webSessions.tokenHash, hashToken(raw)))
    .limit(1);
  if (!row || row.s.expiresAt <= new Date() || row.u.suspendedAt) return null;
  return row.u;
}

/**
 * Development sign in with seeded example accounts. On only when DEV_SIGN_IN=1,
 * or outside production builds unless DEV_SIGN_IN=0. Never on Vercel production.
 */
export function devSignInEnabled(): boolean {
  if (process.env.VERCEL_ENV === 'production') return false;
  if (process.env.DEV_SIGN_IN === '1') return true;
  if (process.env.DEV_SIGN_IN === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

/** Same-origin check for form POSTs (CSRF defense alongside SameSite=Lax). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Only relative, same-site paths may be redirect targets after sign in. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}
