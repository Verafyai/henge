import { revokeRequestSchema } from '@swarm-explorer/api-client';
import { NO_STORE, formBody, oauthError } from '@/lib/api-auth';
import { revokeToken } from '@/lib/auth/oauth';

export const dynamic = 'force-dynamic';

/** RFC 7009: answers 200 whether or not the token existed. */
export async function POST(req: Request) {
  const parsed = revokeRequestSchema.safeParse(await formBody(req));
  if (!parsed.success) return oauthError({ error: 'invalid_request', error_description: 'Missing token or client_id.' });
  await revokeToken(parsed.data.client_id, parsed.data.token);
  return new Response(null, { status: 200, headers: NO_STORE });
}
