import { tokenRequestSchema, tokenResponseSchema } from '@swarm-explorer/api-client';
import { json } from '@/lib/api';
import { NO_STORE, formBody, oauthError } from '@/lib/api-auth';
import { exchangeCode, refreshGrant } from '@/lib/auth/oauth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await formBody(req);
  if (!body) return oauthError({ error: 'invalid_request', error_description: 'Send application/x-www-form-urlencoded.' });
  const parsed = tokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    const unsupported = body.grant_type && !['authorization_code', 'refresh_token'].includes(body.grant_type);
    return oauthError({ error: unsupported ? 'unsupported_grant_type' : 'invalid_request', error_description: 'Missing or invalid parameters.' });
  }
  const r = parsed.data.grant_type === 'authorization_code' ? await exchangeCode(parsed.data) : await refreshGrant(parsed.data);
  if (!r.ok) return oauthError(r.err, r.err.error === 'invalid_client' ? 401 : 400);
  return json(tokenResponseSchema, r.tokens, { headers: NO_STORE });
}
