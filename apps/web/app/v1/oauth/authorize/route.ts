import { authorizeQuerySchema } from '@swarm-explorer/api-client';
import { z } from 'zod';
import { apiError } from '@/lib/api';
import { formBody } from '@/lib/api-auth';
import { findClient, issueCode, redirectAllowed } from '@/lib/auth/oauth';
import { sameOrigin, sessionUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** GET hands the request to the consent page, which checks sign in and shows who is signing in. */
export function GET(req: Request) {
  const u = new URL(req.url);
  return Response.redirect(new URL(`/authorize${u.search}`, u.origin), 302);
}

const decisionSchema = authorizeQuerySchema.extend({ decision: z.enum(['allow', 'deny']) });

/** POST is the consent form. Issues a single-use code and returns the browser to the client. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return apiError(403, 'cross_origin', 'This form must be submitted from Swarm Explorer.');
  const body = await formBody(req);
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) return apiError(400, 'invalid_request', 'The sign in request is incomplete.');
  const q = parsed.data;
  const client = await findClient(q.client_id);
  // Never redirect to a URI we have not validated against the client registration.
  if (!client || !redirectAllowed(client.redirectUris, q.redirect_uri)) return apiError(400, 'invalid_client', 'Unknown client or redirect.');
  const user = await sessionUser();
  if (!user) return apiError(401, 'signed_out', 'Sign in first.');

  const back = new URL(q.redirect_uri);
  back.searchParams.set('state', q.state);
  if (q.decision === 'deny') {
    back.searchParams.set('error', 'access_denied');
  } else {
    back.searchParams.set('code', await issueCode({ clientId: client.id, accountId: user.id, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge }));
  }
  return new Response(null, { status: 303, headers: { location: back.toString(), 'cache-control': 'no-store' } });
}
