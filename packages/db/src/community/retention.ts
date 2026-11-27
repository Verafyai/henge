/**
 * Retention (spin-out spec 8.2): messages follow the `.henge` `data_policy.retention_days`; soft-deleted
 * bodies are kept 30 days as evidence and then purged. Realtime events, expired handle holds and idle
 * rate buckets are pruned too. Runs opportunistically (at most hourly per Henge per instance) and can be
 * called from a scheduled job.
 */
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { getDb } from '../client';
import { communityEvents, communityHandles, communityMessages, communityRateBuckets, communityReports } from '../community-schema';
import { DELETED_EVIDENCE_MS } from './config';

const RUN_EVERY_MS = 3600_000;
export const EVENT_TTL_MS = 24 * 3600_000;
const lastRun = new Map<string, number>();

export async function maybePurge(hengeId: string, retentionDays: number, now = new Date()) {
  const prev = lastRun.get(hengeId) ?? 0;
  if (now.getTime() - prev < RUN_EVERY_MS) return null;
  lastRun.set(hengeId, now.getTime());
  return purgeHenge(hengeId, retentionDays, now);
}

export async function purgeHenge(hengeId: string, retentionDays: number, now = new Date()) {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const expired = await db
    .delete(communityMessages)
    .where(and(eq(communityMessages.hengeId, hengeId), lt(communityMessages.createdAt, cutoff)))
    .returning({ id: communityMessages.id });
  const purged = await db
    .update(communityMessages)
    .set({ body: '', mentionActorIds: [], purgedAt: now })
    .where(and(eq(communityMessages.hengeId, hengeId), isNotNull(communityMessages.deletedAt), isNull(communityMessages.purgedAt), lt(communityMessages.deletedAt, new Date(now.getTime() - DELETED_EVIDENCE_MS))))
    .returning({ id: communityMessages.id });
  await db
    .update(communityReports)
    .set({ snapshot: null })
    .where(and(eq(communityReports.hengeId, hengeId), isNotNull(communityReports.resolvedAt), lt(communityReports.createdAt, cutoff)));
  await db.delete(communityEvents).where(lt(communityEvents.createdAt, new Date(now.getTime() - EVENT_TTL_MS)));
  await db.delete(communityHandles).where(lt(communityHandles.heldUntil, now));
  await db.delete(communityRateBuckets).where(lt(communityRateBuckets.updatedAt, new Date(now.getTime() - EVENT_TTL_MS)));
  return { expired: expired.length, purged: purged.length };
}
