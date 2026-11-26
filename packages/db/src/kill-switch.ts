/**
 * Platform kill switch (SPEC 11.6, 15.2; M7). A platform admin stops all work, or one swarm, with a
 * signed entry in the revocation feed, and lifts it again with a signed `restore` entry. The newest
 * entry per target decides.
 *
 * While a stop is in force the coordinator leases nothing in its scope, refuses qualification work
 * and lease starts, and the stop itself cancels every open lease in scope at once: the lease is
 * abandoned with `cancel_reason = kill_switch`, its task goes back to the queue unpaid and any pool
 * reservation is released. Nodes learn of the stop from the signed feed (they poll it) or from the
 * `killed` / `swarm_killed` refusal on their next coordinator call, and stop the running task.
 */
import { REVOCATION_PREFIX, revocationCanonical, signStatement, type RevocationPayload } from '@swarm-explorer/schema/node';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb, type Db } from './client';
import { MembershipError } from './errors';
import { releaseReservation, type Tx } from './ledger';
import { registeredPlatformKey } from './platform-keys';
import { leases, outboxEvents, revocations, swarms, tasks } from './schema';
import { uuidv7 } from './uuid';

type Row = typeof revocations.$inferSelect;
const OPEN = ['leased', 'running'] as const;
export const KILL_CANCEL_REASON = 'kill_switch';

export type KillStateRows = { global: Row | null; swarms: Map<string, Row> };

/** The stops in force at `now`, from the database (the coordinator's own view of the feed). */
export async function currentKillState(tx: Tx | Db, now = new Date()): Promise<KillStateRows> {
  const rows = await tx
    .select()
    .from(revocations)
    .where(inArray(revocations.targetType, ['platform', 'swarm']))
    .orderBy(asc(revocations.effectiveAt), asc(revocations.createdAt));
  const latest = new Map<string, Row>();
  for (const r of rows) if (r.effectiveAt <= now) latest.set(`${r.targetType}:${r.targetId}`, r);
  const state: KillStateRows = { global: null, swarms: new Map() };
  for (const r of latest.values()) {
    if (r.action !== 'revoke') continue;
    if (r.targetType === 'platform') state.global = r;
    else state.swarms.set(r.targetId, r);
  }
  return state;
}

/** Throws `killed` (all work) or `swarm_killed` (this swarm) while a stop is in force. */
export async function assertWorkAllowed(tx: Tx | Db, o: { swarmSlug?: string; swarmId?: string }, now = new Date()) {
  const state = await currentKillState(tx, now);
  if (state.global) throw new MembershipError(409, 'killed', `Verafy has stopped all work for now: ${state.global.reason}`, { revocation_id: state.global.id });
  if (!state.swarms.size) return;
  let slug = o.swarmSlug;
  if (!slug && o.swarmId) {
    const [s] = await tx.select({ slug: swarms.slug }).from(swarms).where(eq(swarms.id, o.swarmId)).limit(1);
    slug = s?.slug;
  }
  const hit = slug ? state.swarms.get(slug) : undefined;
  if (hit) throw new MembershipError(409, 'swarm_killed', `Verafy has stopped this swarm for now: ${hit.reason}`, { revocation_id: hit.id, swarm: slug });
}

export type KillCommand = {
  target: 'platform' | 'swarm';
  /** The swarm slug when `target` is `swarm`. */
  swarm?: string;
  action: 'revoke' | 'restore';
  reason: string;
  actorAccountId: string;
  idempotencyKey: string;
  now?: Date;
};

export type KillOutcome = { entry: Row; duplicate: boolean; cancelledLeases: number };

/**
 * Records a signed kill switch entry. Idempotent by key: a repeat returns the first entry. Stopping
 * something already stopped, or restoring something not stopped, is refused so the feed stays a clean
 * history of real changes.
 */
export async function setKillSwitch(o: KillCommand): Promise<KillOutcome> {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [seen] = await tx.select().from(revocations).where(eq(revocations.idempotencyKey, o.idempotencyKey)).limit(1);
    if (seen) return { entry: seen, duplicate: true, cancelledLeases: 0 };

    let swarmRow: typeof swarms.$inferSelect | undefined;
    if (o.target === 'swarm') {
      [swarmRow] = await tx.select().from(swarms).where(eq(swarms.slug, o.swarm ?? '')).limit(1);
      if (!swarmRow) throw new MembershipError(404, 'not_found', 'No swarm with that id.');
    }
    const targetId = o.target === 'platform' ? '*' : swarmRow!.slug;
    const state = await currentKillState(tx, now);
    const active = o.target === 'platform' ? state.global : (state.swarms.get(targetId) ?? null);
    if (o.action === 'revoke' && active) throw new MembershipError(409, 'already_stopped', 'This is already stopped.', { revocation_id: active.id });
    if (o.action === 'restore' && !active) throw new MembershipError(409, 'not_stopped', 'This is not stopped.');

    // Entries for one target are strictly ordered, so "newest wins" never ties.
    const [last] = await tx
      .select({ at: revocations.effectiveAt })
      .from(revocations)
      .where(and(eq(revocations.targetType, o.target), eq(revocations.targetId, targetId)))
      .orderBy(desc(revocations.effectiveAt))
      .limit(1);
    const effectiveAt = last && last.at >= now ? new Date(last.at.getTime() + 1) : now;

    const key = await registeredPlatformKey(tx, 'revocation');
    const id = uuidv7();
    const payload: RevocationPayload = {
      revocation_version: 1,
      id,
      target_type: o.target,
      target_id: targetId,
      action: o.action,
      reason: o.reason,
      severity: 'critical',
      effective_at: effectiveAt.toISOString(),
    };
    const signedPayload = revocationCanonical(payload);
    const [entry] = await tx
      .insert(revocations)
      .values({
        id,
        targetType: o.target,
        targetId,
        reason: o.reason,
        severity: 'critical',
        signedPayload,
        signature: signStatement(REVOCATION_PREFIX, signedPayload, key),
        effectiveAt,
        action: o.action,
        actorAccountId: o.actorAccountId,
        idempotencyKey: o.idempotencyKey,
      })
      .returning();

    let cancelledLeases = 0;
    if (o.action === 'revoke') cancelledLeases = await cancelOpenLeases(tx, swarmRow?.id ?? null, now);
    await tx.insert(outboxEvents).values({
      topic: 'swarm.revoked',
      payload: { revocation_id: id, target_type: o.target, target_id: targetId, action: o.action, cancelled_leases: cancelledLeases },
    });
    return { entry: entry!, duplicate: false, cancelledLeases };
  });
}

/** Cancels every open lease (all swarms when `swarmId` is null): unpaid, requeued, reservation released. */
async function cancelOpenLeases(tx: Tx, swarmId: string | null, now: Date): Promise<number> {
  const open = await tx
    .select({ lease: leases, swarmId: tasks.swarmId })
    .from(leases)
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .where(and(inArray(leases.status, [...OPEN]), swarmId ? eq(tasks.swarmId, swarmId) : undefined));
  for (const { lease, swarmId: sid } of open) {
    await tx.update(leases).set({ status: 'abandoned', abandonedAt: now, requeuedAt: now, cancelReason: KILL_CANCEL_REASON }).where(eq(leases.id, lease.id));
    await tx.update(tasks).set({ status: 'queued' }).where(and(eq(tasks.id, lease.taskId), eq(tasks.status, 'leased')));
    await releaseReservation(tx, { leaseId: lease.id, swarmId: sid });
    await tx.insert(outboxEvents).values({ topic: 'lease.abandoned', payload: { lease_id: lease.id, task_id: lease.taskId, node_id: lease.nodeId, reason: KILL_CANCEL_REASON } });
  }
  return open.length;
}
