import { apiError } from '@/lib/api';
import { STATE_COOKIE, STATE_TTL_S, callbackUrl, encodeStateCookie, githubCredentials, newState } from '@/lib/auth/github';
import { safeNext } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** Starts GitHub sign in. 404 unless the GitHub OAuth app's keys are configured. */
export async function GET(req: Request) {
  const creds = githubCredentials();
  if (!creds) return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
  const next = safeNext(new URL(req.url).searchParams.get('next'));
  const state = newState();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', creds.clientId);
  authorize.searchParams.set('redirect_uri', callbackUrl(req));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('scope', 'read:user');
  authorize.searchParams.set('allow_signup', 'false');
  const secure = callbackUrl(req).startsWith('https:');
  const cookie = `${STATE_COOKIE}=${encodeStateCookie(state, next)}; Path=/v1/auth/github; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_S}${secure ? '; Secure' : ''}`;
  return new Response(null, { status: 302, headers: { location: authorize.toString(), 'set-cookie': cookie, 'cache-control': 'no-store' } });
}
