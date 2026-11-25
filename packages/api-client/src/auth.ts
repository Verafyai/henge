/**
 * OAuth 2.0 for native apps (SPEC 4.4; RFC 6749, 7636, 8252) and the
 * signed-in endpoints. Shared by the API handlers and the desktop client.
 */
import { z } from 'zod';

export const DESKTOP_CLIENT_ID = 'swarm-explorer-desktop';
export const ACCESS_TOKEN_TTL_S = 15 * 60;

/** RFC 7636: 43 to 128 characters from the unreserved set. */
export const pkceVerifierSchema = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/);
const b64uHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Update channels (SPEC 15.1); unpackaged development runs report "dev". */
export const channelSchema = z.enum(['stable', 'beta', 'internal', 'dev']);

export const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().min(1).max(512),
  state: z.string().min(16).max(256),
  code_challenge: b64uHash,
  code_challenge_method: z.literal('S256'),
});
export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;

export const deviceInfoSchema = z.object({
  device_platform: z.string().min(1).max(32),
  device_arch: z.string().min(1).max(32),
  app_version: z.string().min(1).max(64),
  channel: channelSchema,
  /** Ed25519 SPKI DER, base64url. */
  device_pubkey: z.string().regex(/^[A-Za-z0-9_-]{40,120}$/),
});

export const codeGrantSchema = z
  .object({
    grant_type: z.literal('authorization_code'),
    client_id: z.string().min(1).max(64),
    code: z.string().min(20).max(200),
    code_verifier: pkceVerifierSchema,
    redirect_uri: z.string().min(1).max(512),
  })
  .extend(deviceInfoSchema.shape);

/** Refresh requests carry a device signature over `refresh.{install_id}.{device_ts}`. */
export const refreshGrantSchema = z.object({
  grant_type: z.literal('refresh_token'),
  client_id: z.string().min(1).max(64),
  refresh_token: z.string().min(20).max(200),
  install_id: z.uuid(),
  device_ts: z.coerce.number().int().positive(),
  device_sig: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
});

export const tokenRequestSchema = z.discriminatedUnion('grant_type', [codeGrantSchema, refreshGrantSchema]);

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string(),
  install_id: z.uuid(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** RFC 6749 section 5.2 error body. */
export const oauthErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() });

export const revokeRequestSchema = z.object({ client_id: z.string().min(1).max(64), token: z.string().min(20).max(200) });

export const meSchema = z.object({
  id: z.uuid(),
  handle: z.string(),
  displayName: z.string(),
  installId: z.uuid(),
});
export type Me = z.infer<typeof meSchema>;

export const installSchema = z.object({
  id: z.uuid(),
  platform: z.string(),
  arch: z.string(),
  version: z.string(),
  channel: channelSchema,
  createdAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  current: z.boolean(),
});
export const installListSchema = z.object({ items: z.array(installSchema) });

/** POST /v1/installs (SPEC 13.1): registers this install's details and its node after sign in. */
export const registerInstallSchema = z.object({
  app_version: z.string().min(1).max(64),
  channel: channelSchema,
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
});
export const registerInstallResponseSchema = z.object({
  install_id: z.uuid(),
  node_id: z.uuid(),
  node_status: z.enum(['setup', 'ready', 'paused', 'offline', 'blocked']),
});
export type RegisterInstallResponse = z.infer<typeof registerInstallResponseSchema>;

export const capabilitiesAcceptedSchema = z.object({ node_id: z.uuid(), observed_at: z.iso.datetime({ offset: true }) });

export const releasesQuerySchema = z.object({
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
  channel: z.enum(['stable', 'beta', 'internal']),
  install_id: z.uuid().optional(),
});

export const releaseListSchema = z.object({
  items: z.array(
    z.object({
      version: z.string(),
      channel: z.string(),
      platform: z.string(),
      arch: z.string(),
      url: z.string(),
      sha256: z.string(),
      publishedAt: z.iso.datetime({ offset: true }),
    }),
  ),
});

/**
 * Node requests carry a device signature over method, path, body hash, timestamp and nonce
 * (SPEC 13), on top of the bearer token. A stolen access token alone cannot call node endpoints.
 */
export const DEVICE_HEADERS = { ts: 'x-device-ts', nonce: 'x-device-nonce', signature: 'x-device-signature' } as const;
export const DEVICE_NONCE = /^[A-Za-z0-9_-]{22,64}$/;

/** `path` includes the query string. `bodySha256` is base64url SHA-256 of the exact body bytes ("" hashed when empty). */
export function deviceRequestMessage(p: { method: string; path: string; bodySha256: string; ts: number; nonce: string }): string {
  return ['swarm-explorer-device-v1', p.method.toUpperCase(), p.path, p.bodySha256, String(p.ts), p.nonce].join('\n');
}

/** The message a device signs for a refresh. Shared so both sides build identical bytes. */
export function refreshProofMessage(installId: string, ts: number): string {
  return `refresh.${installId}.${ts}`;
}
