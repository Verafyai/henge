import { apiError } from '@/lib/api';
import {
  STATE_COOKIE,
  accountForGithubUser,
  allowedGithubUser,
  callbackUrl,
  fetchGithubUser,
  githubSignInEnabled,
  readCookie,
  readStateCookie,
  sameState,
} from '@/lib/auth/github';
import { createSession, safeNext } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const CLEAR = `${STATE_COOKIE}=; Path=/v1/auth/github; HttpOnly; SameSite=Lax; Max-Age=0`;

function refused(status: number, code: string, message: string): Response {
  const res = apiError(status, code, message);
  res.headers.append('set-cookie', CLEAR);
  return res;
}

/** GitHub redirects here. Only allowlisted GitHub accounts get a session. */
export async function GET(req: Request) {
  if (!githubSignInEnabled()) return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const saved = readStateCookie(readCookie(req, STATE_COOKIE));
  if (!code || !state || !saved || !sameState(state, saved.state)) return refused(400, 'invalid_state', 'Sign in expired or was not started here. Try again.');
  const user = await fetchGithubUser(code, callbackUrl(req));
  if (!user) return refused(502, 'github_failed', 'GitHub did not confirm the sign in. Try again.');
  if (!allowedGithubUser(user.id)) return refused(403, 'not_allowed', 'This GitHub account is not on the staging allowlist.');
  await createSession(await accountForGithubUser(user));
  return new Response(null, { status: 303, headers: { location: safeNext(saved.next), 'set-cookie': CLEAR, 'cache-control': 'no-store' } });
}
