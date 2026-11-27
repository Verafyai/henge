/**
 * Token buckets in Postgres (spin-out spec 8.2). One atomic upsert per take: the bucket refills at
 * `perMinute / 60` tokens a second up to `capacity`, and a take succeeds only with a whole token left.
 * Slow mode is a bucket of one token that refills once every `slow_mode_s` seconds.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../client';
import { communityRateBuckets } from '../community-schema';
import { CommunityError, type Exec } from './context';

export type Take = { ok: true } | { ok: false; retryAfterS: number };

export async function takeToken(key: string, capacity: number, refillPerSecond: number, now = new Date(), db?: Exec): Promise<Take> {
  const d = db ?? (await getDb());
  const t = now.toISOString();
  const refilled = sql`least(${capacity}::double precision, ${communityRateBuckets.tokens} + greatest(0, extract(epoch from (${t}::timestamptz - ${communityRateBuckets.updatedAt}))) * ${refillPerSecond}::double precision)`;
  const taken = await d
    .insert(communityRateBuckets)
    .values({ key, tokens: capacity - 1, updatedAt: now })
    .onConflictDoUpdate({
      target: communityRateBuckets.key,
      set: { tokens: sql`${refilled} - 1`, updatedAt: now },
      setWhere: sql`${refilled} >= 1`,
    })
    .returning({ tokens: communityRateBuckets.tokens });
  if (taken.length) return { ok: true };
  const rows = await d.execute<{ tokens: number }>(sql`select ${refilled} as tokens from ${communityRateBuckets} where ${communityRateBuckets.key} = ${key}`);
  const current = Number((rows as unknown as { rows?: { tokens: number }[] }).rows?.[0]?.tokens ?? (rows as unknown as { tokens: number }[])[0]?.tokens ?? 0);
  return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - current) / refillPerSecond)) };
}

export function rateLimited(retryAfterS: number, message: string, code = 'rate_limited'): CommunityError {
  return new CommunityError(429, code, message, { retry_after_s: retryAfterS });
}

/** Messages, reactions: `perMinute` tokens with a full minute's burst. */
export async function takePerMinute(key: string, perMinute: number, now = new Date()): Promise<Take> {
  return takeToken(key, perMinute, perMinute / 60, now);
}

export async function takeSlowMode(key: string, slowModeS: number, now = new Date()): Promise<Take> {
  return takeToken(key, 1, 1 / slowModeS, now);
}
