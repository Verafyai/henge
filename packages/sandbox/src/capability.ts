/**
 * Model capability tokens (SPEC 11.2): short-lived, scoped to one lease, one model and class, a
 * maximum token count, a maximum cost and the approved permissions hash. HMAC-SHA256 with a key
 * that lives only in the supervisor and proxy processes for one app session.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const capabilityClaimsSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  lease: z.string().min(1).max(100),
  model: z.string().regex(/^sha256-[a-f0-9]{64}$/),
  model_class: z.string().max(80),
  max_tokens: z.number().int().positive().max(1_000_000),
  max_cost_usd_micros: z.number().int().nonnegative(),
  permissions_hash: z.string().regex(/^sha256-[a-f0-9]{64}$/),
  exp: z.number().int(),
});
export type CapabilityClaims = z.infer<typeof capabilityClaimsSchema>;

const b64u = (b: Buffer) => b.toString('base64url');

export function newCapabilityKey(): Buffer {
  return randomBytes(32);
}

export function mintCapability(key: Buffer, c: Omit<CapabilityClaims, 'v' | 'id' | 'exp'>, ttlMs: number, now = Date.now()): string {
  const claims: CapabilityClaims = { v: 1, id: b64u(randomBytes(18)), ...c, exp: now + ttlMs };
  const payload = b64u(Buffer.from(JSON.stringify(claims)));
  return `sxk_${payload}.${b64u(createHmac('sha256', key).update(payload).digest())}`;
}

export type CapabilityCheck = { ok: true; claims: CapabilityClaims } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyCapability(key: Buffer, token: string, now = Date.now()): CapabilityCheck {
  const m = /^sxk_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const expected = createHmac('sha256', key).update(m[1]!).digest();
  const given = Buffer.from(m[2]!, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const claims = capabilityClaimsSchema.safeParse(raw);
  if (!claims.success) return { ok: false, reason: 'malformed' };
  if (claims.data.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: claims.data };
}
