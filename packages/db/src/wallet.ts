/**
 * What a contributor sees of their work (SPEC 4.1 Activity and Wallet, 13.4): each result's real
 * state, impact, and credits only where a funded swarm really moved them. Nothing here estimates or
 * projects: pending is pending, and volunteer work shows impact only.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from './client';
import { accountBalances, pendingForResult } from './ledger';
import { creditAccounts, impactEvents, leases, ledgerEntries, results, swarmReleases, swarms, tasks } from './schema';

export type ResultState = 'submitted' | 'verifying' | 'pending' | 'settled' | 'rejected' | 'clawed_back' | 'not_counted';

export type ResultView = {
  resultId: string;
  leaseId: string;
  swarm: string;
  swarmName: string;
  funded: boolean;
  state: ResultState;
  /** Late and after-abandon results are recorded and never counted (SPEC 7.3). */
  disposition: 'on_time' | 'late' | 'after_abandon';
  timeline: Array<{ state: Exclude<ResultState, 'not_counted'>; at: string }>;
  impact: { units: number; status: 'pending' | 'settled' | 'revoked' } | null;
  credits: { amount: number; status: 'pending' | 'settled' | 'clawed_back' } | null;
  submittedAt: string;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function resultsFor(accountId: string, limit = 50): Promise<ResultView[]> {
  const db = await getDb();
  const rows = await db
    .select({ result: results, lease: leases, swarm: swarms, release: swarmReleases })
    .from(results)
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .innerJoin(swarms, eq(swarms.id, tasks.swarmId))
    .innerJoin(swarmReleases, eq(swarmReleases.id, tasks.releaseId))
    .where(eq(leases.accountId, accountId))
    .orderBy(desc(results.submittedAt), desc(results.id))
    .limit(limit);
  const ids = rows.map((r) => r.result.id);
  const impacts = ids.length ? await db.select().from(impactEvents).where(inArray(impactEvents.resultId, ids)) : [];
  const out: ResultView[] = [];
  for (const r of rows) {
    const l = r.lease;
    const counted = r.result.disposition === 'on_time';
    const state: ResultState = !counted ? 'not_counted' : (['submitted', 'verifying', 'pending', 'settled', 'rejected', 'clawed_back'] as const).find((s) => s === l.status) ?? 'submitted';
    const timeline = (
      [
        ['submitted', l.submittedAt ?? r.result.submittedAt],
        ['verifying', l.verifyingAt],
        ['pending', l.pendingAt],
        ['settled', l.settledAt],
        ['rejected', l.rejectedAt],
        ['clawed_back', l.clawedBackAt],
      ] as const
    ).flatMap(([s, at]) => (counted && at ? [{ state: s, at: iso(at)! }] : []));
    const imp = impacts.find((i) => i.resultId === r.result.id);
    const credit = await pendingForResult(db, r.result.id);
    out.push({
      resultId: r.result.id,
      leaseId: l.id,
      swarm: r.swarm.slug,
      swarmName: (r.release.manifestJson as { name: string }).name,
      funded: r.swarm.fundedMode === 'funded',
      state,
      disposition: r.result.disposition,
      timeline,
      impact: imp ? { units: imp.units, status: imp.revokedAt ? 'revoked' : l.status === 'settled' ? 'settled' : 'pending' } : null,
      credits: credit ? { amount: credit, status: l.status === 'settled' ? 'settled' : l.status === 'clawed_back' ? 'clawed_back' : 'pending' } : null,
      submittedAt: r.result.submittedAt.toISOString(),
    });
  }
  return out;
}

/** Wallet summary (SPEC 13.4): settled, pending and reserved credits, and impact. */
export async function walletFor(accountId: string) {
  const db = await getDb();
  const credits = await accountBalances(db, accountId);
  const imp = await db
    .select({ units: impactEvents.units, status: leases.status })
    .from(impactEvents)
    .innerJoin(results, eq(results.id, impactEvents.resultId))
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .where(and(eq(impactEvents.accountId, accountId), isNull(impactEvents.revokedAt)));
  const impact = { settled: 0, pending: 0 };
  for (const i of imp) impact[i.status === 'settled' ? 'settled' : 'pending'] += i.units;
  const funded = await db
    .select({ id: results.id })
    .from(results)
    .innerJoin(leases, eq(leases.id, results.leaseId))
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .innerJoin(swarms, eq(swarms.id, tasks.swarmId))
    .where(and(eq(leases.accountId, accountId), eq(swarms.fundedMode, 'funded')))
    .limit(1);
  return { credits, impact, hasFundedWork: funded.length > 0 };
}

/** The caller's own ledger rows, newest first (SPEC 13.4 `GET /ledger`). */
export async function ledgerFor(accountId: string, limit = 100) {
  const db = await getDb();
  return db
    .select({ entry: ledgerEntries, bucket: creditAccounts.bucket })
    .from(ledgerEntries)
    .innerJoin(creditAccounts, eq(creditAccounts.id, ledgerEntries.creditAccountId))
    .where(and(eq(creditAccounts.ownerType, 'account'), eq(creditAccounts.ownerId, accountId)))
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
    .limit(limit);
}
