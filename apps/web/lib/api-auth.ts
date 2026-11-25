import { oauthErrorSchema } from '@swarm-explorer/api-client';
import type { OAuthError } from './auth/oauth';
import { json } from './api';

export const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

/** RFC 6749 section 5.2 error response. */
export function oauthError(err: OAuthError, status = 400): Response {
  return json(oauthErrorSchema, err, { status, headers: NO_STORE });
}

/** Reads an application/x-www-form-urlencoded body into a plain object. */
export async function formBody(req: Request): Promise<Record<string, string> | null> {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return null;
  const text = await req.text();
  if (text.length > 8192) return null;
  return Object.fromEntries(new URLSearchParams(text));
}
