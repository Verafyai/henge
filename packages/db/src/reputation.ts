/**
 * Reputation events (SPEC 8.4). Each event stores its scoring version and evidence, once per kind
 * and evidence. Scoring version `unit-v0` only counts: +1 per accepted result, -1 per rejection,
 * clawback or repeated-miss threshold crossing. It is a placeholder with no business effect; task
 * limits, high-value access and jury eligibility do not read it yet, and the real weights, decay and
 * formula need Rex's approval.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './ledger';
import { outboxEvents, reputationEvents } from './schema';

export const SCORE_VERSION = 'unit-v0';

export type ReputationEventType = 'result_accepted' | 'result_rejected' | 'result_clawed_back' | 'repeated_deadline_miss';

const DELTA: Record<ReputationEventType, number> = { result_accepted: 1, result_rejected: -1, result_clawed_back: -1, repeated_deadline_miss: -1 };

export async function recordReputation(tx: Tx, o: { accountId: string; nodeId: string | null; swarmId: string | null; type: ReputationEventType; evidenceRef: string }) {
  const inserted = await tx
    .insert(reputationEvents)
    .values({ accountId: o.accountId, nodeId: o.nodeId, swarmId: o.swarmId, eventType: o.type, delta: DELTA[o.type], scoreVersion: SCORE_VERSION, evidenceRef: o.evidenceRef })
    .onConflictDoNothing()
    .returning({ id: reputationEvents.id });
  if (!inserted.length) return false;
  await tx.insert(outboxEvents).values({ topic: 'reputation.changed', payload: { account_id: o.accountId, node_id: o.nodeId, swarm_id: o.swarmId, event: o.type, score_version: SCORE_VERSION } });
  return true;
}

/** Derived score per account (and optionally per node and swarm); never stored as a mutable number. */
export async function reputationScore(tx: Tx | Db, o: { accountId: string; nodeId?: string; swarmId?: string }) {
  const [r] = await tx
    .select({ s: sql<string>`coalesce(sum(${reputationEvents.delta}), 0)` })
    .from(reputationEvents)
    .where(and(eq(reputationEvents.accountId, o.accountId), o.nodeId ? eq(reputationEvents.nodeId, o.nodeId) : undefined, o.swarmId ? eq(reputationEvents.swarmId, o.swarmId) : undefined));
  return Number(r?.s ?? 0);
}
