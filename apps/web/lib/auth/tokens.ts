import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque tokens with a type prefix (helps secret scanners). Only the SHA-256
 * hash is stored; the raw value exists once, in the response to the client.
 */
export function newToken(prefix: 'sxa' | 'sxr' | 'sxc' | 'sxs'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

/** PKCE S256 (RFC 7636 section 4.2). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
