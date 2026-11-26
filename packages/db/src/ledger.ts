/**
 * Credit ledger (SPEC 9). Append-only double entry: every movement is one transaction of legs that
 * debit one bucket and credit another by the same integer amount. A bucket's balance is the sum of
 * its credits minus its debits; nothing stores a mutable balance except the pool caches, which are
 * rebuilt from entries inside the same transaction (SPEC 9.5).
 *
 * Buckets: a pool has `available` and `reserved`; a node's account has `pending` and `settled`; the
 * platform's `issued` mirrors credits bought from outside and is the only bucket allowed below zero.
 *
 * Volunteer swarms never touch this ledger: they award impact only (SPEC 9.1). Credits are earned,
 * never bought by users, and there are no transfers or cash-out.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import { LedgerError } from './errors';
import { creditAccounts, leases, ledgerEntries, pools, swarms, tasks } from './schema';
import { uuidv7 } from './uuid';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Exec = Tx | Db;
export type Bucket = (typeof creditAccounts.$inferSelect)['bucket'];
export type OwnerType = (typeof creditAccounts.$inferSelect)['ownerType'];
export type Movement = (typeof ledgerEntries.$inferSelect)['movementType'];

export { LedgerError };

/** The credit account for one owner's bucket, created on first use. */
export async function creditAccount(tx: Exec, ownerType: OwnerType, ownerId: string | null, bucket: Bucket): Promise<string> {
  const where = and(eq(creditAccounts.ownerType, ownerType), ownerId === null ? sql`${creditAccounts.ownerId} is null` : eq(creditAccounts.ownerId, ownerId), eq(creditAccounts.bucket, bucket));
  const [found] = await tx.select({ id: creditAccounts.id }).from(creditAccounts).where(where).limit(1);
  if (found) return found.id;
  await tx.insert(creditAccounts).values({ ownerType, ownerId, bucket }).onConflictDoNothing();
  const [made] = await tx.select({ id: creditAccounts.id }).from(creditAccounts).where(where).limit(1);
  return made!.id;
}

export async function balance(tx: Exec, accountId: string): Promise<number> {
  const [r] = await tx
    .select({ b: sql<string>`coalesce(sum(${ledgerEntries.creditCredits}) - sum(${ledgerEntries.debitCredits}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.creditAccountId, accountId));
  return Number(r?.b ?? 0);
}

export type Transfer = { from: string; to: string; amount: number };

/**
 * Posts one balanced transaction. Idempotent by key: a repeat with the same key is a no-op and
 * returns the first transaction. Refuses non-integer or non-positive amounts and any leg that would
 * leave a bucket other than `issued` below zero.
 */
export async function postTransaction(tx: Tx, o: { movement: Movement; transfers: Transfer[]; referenceType: string; referenceId: string; idempotencyKey: string; correlationId?: string }) {
  const [prior] = await tx.select({ txnId: ledgerEntries.txnId }).from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, o.idempotencyKey)).limit(1);
  if (prior) return { txnId: prior.txnId, replay: true };
  if (!o.transfers.length) throw new LedgerError(500, 'ledger_empty', 'A ledger transaction needs at least one transfer.');
  const legs = new Map<string, { debit: number; credit: number }>();
  for (const t of o.transfers) {
    if (!Number.isSafeInteger(t.amount) || t.amount <= 0) throw new LedgerError(500, 'ledger_amount', 'Ledger amounts are positive whole credits.');
    if (t.from === t.to) throw new LedgerError(500, 'ledger_same_account', 'A transfer needs two different accounts.');
    const f = legs.get(t.from) ?? { debit: 0, credit: 0 };
    f.debit += t.amount;
    legs.set(t.from, f);
    const c = legs.get(t.to) ?? { debit: 0, credit: 0 };
    c.credit += t.amount;
    legs.set(t.to, c);
  }
  const txnId = uuidv7();
  const correlationId = o.correlationId ?? txnId;
  const rows = [...legs.entries()].flatMap(([accountId, l]) => {
    const net = l.credit - l.debit;
    if (net === 0) return [];
    return [{ txnId, creditAccountId: accountId, debitCredits: net < 0 ? -net : 0, creditCredits: net > 0 ? net : 0, movementType: o.movement, referenceType: o.referenceType, referenceId: o.referenceId, idempotencyKey: o.idempotencyKey, correlationId }];
  });
  await tx.insert(ledgerEntries).values(rows);
  const touched = await tx.select().from(creditAccounts).where(inArray(creditAccounts.id, rows.map((r) => r.creditAccountId)));
  for (const a of touched) {
    if (a.bucket === 'issued') continue;
    if ((await balance(tx, a.id)) < 0) throw new LedgerError(409, 'insufficient_credits', `The ${a.bucket} balance cannot go below zero.`);
  }
  await refreshPoolCaches(tx, touched.filter((a) => a.ownerType === 'pool').map((a) => a.ownerId!));
  return { txnId, replay: false };
}

/** Rebuilds pool caches from entries. Pool credit accounts are owned by the pool's swarm. */
async function refreshPoolCaches(tx: Tx, swarmIds: string[]) {
  for (const swarmId of new Set(swarmIds)) {
    const available = await balance(tx, await creditAccount(tx, 'pool', swarmId, 'available'));
    const reserved = await balance(tx, await creditAccount(tx, 'pool', swarmId, 'reserved'));
    await tx.update(pools).set({ availableCached: available, reservedCached: reserved }).where(eq(pools.swarmId, swarmId));
  }
}

async function fundedPool(tx: Tx, swarmId: string) {
  const [r] = await tx.select({ pool: pools, swarm: swarms }).from(pools).innerJoin(swarms, eq(swarms.id, pools.swarmId)).where(eq(pools.swarmId, swarmId)).limit(1);
  // Volunteer swarms award impact only: there is no pool to pay from, so no credit can exist (SPEC 9.1).
  if (!r || r.swarm.fundedMode !== 'funded' || r.pool.fundedMode !== 'funded') throw new LedgerError(409, 'volunteer_swarm', 'Volunteer swarms award impact only, never credits.');
  return r.pool;
}

/**
 * Credits into a funded pool from outside (SPEC 9.5 purchase). Real purchases need approved pricing
 * and a hosted checkout (M9); until then only tests and fixtures call this.
 */
export async function fundPool(tx: Tx, o: { swarmId: string; amount: number; reference: string }) {
  await fundedPool(tx, o.swarmId);
  return postTransaction(tx, {
    movement: 'purchase',
    transfers: [{ from: await creditAccount(tx, 'platform', null, 'issued'), to: await creditAccount(tx, 'pool', o.swarmId, 'available'), amount: o.amount }],
    referenceType: 'purchase',
    referenceId: o.reference,
    idempotencyKey: `purchase:${o.reference}`,
  });
}

/** Lease reservation (SPEC 9.2 step 2): the possible reward leaves pool availability. */
export async function reserveForLease(tx: Tx, o: { leaseId: string; swarmId: string; amount: number }) {
  await fundedPool(tx, o.swarmId);
  return postTransaction(tx, {
    movement: 'lease_reserve',
    transfers: [{ from: await creditAccount(tx, 'pool', o.swarmId, 'available'), to: await creditAccount(tx, 'pool', o.swarmId, 'reserved'), amount: o.amount }],
    referenceType: 'lease',
    referenceId: o.leaseId,
    idempotencyKey: `reserve:${o.leaseId}`,
  });
}

/** The amount still reserved for a lease: reserved, minus released or paid out. */
export async function reservedForLease(tx: Exec, leaseId: string): Promise<number> {
  const rows = await tx
    .select({ movement: ledgerEntries.movementType, debit: ledgerEntries.debitCredits, credit: ledgerEntries.creditCredits, bucket: creditAccounts.bucket })
    .from(ledgerEntries)
    .innerJoin(creditAccounts, eq(creditAccounts.id, ledgerEntries.creditAccountId))
    .where(and(eq(ledgerEntries.referenceType, 'lease'), eq(ledgerEntries.referenceId, leaseId), eq(creditAccounts.ownerType, 'pool'), eq(creditAccounts.bucket, 'reserved')));
  return rows.reduce((s, r) => s + r.credit - r.debit, 0);
}

/** Returns an unused reservation to the pool (rejection, expiry, abandon). No-op without one. */
export async function releaseReservation(tx: Tx, o: { leaseId: string; swarmId: string }) {
  const left = await reservedForLease(tx, o.leaseId);
  if (left <= 0) return null;
  return postTransaction(tx, {
    movement: 'reserve_release',
    transfers: [{ from: await creditAccount(tx, 'pool', o.swarmId, 'reserved'), to: await creditAccount(tx, 'pool', o.swarmId, 'available'), amount: left }],
    referenceType: 'lease',
    referenceId: o.leaseId,
    idempotencyKey: `release:${o.leaseId}`,
  });
}

/**
 * Accepted result (SPEC 9.2 step 4): the reservation moves to the node account's pending balance.
 * Only with a pool reservation for this lease, and only once per result.
 */
export async function acceptPending(tx: Tx, o: { resultId: string; leaseId: string; accountId: string; swarmId: string; amount: number; verificationRecordId: string }) {
  await fundedPool(tx, o.swarmId);
  const reserved = await reservedForLease(tx, o.leaseId);
  const [prior] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `accept:${o.resultId}`)).limit(1);
  if (!prior && reserved < o.amount) throw new LedgerError(409, 'reservation_missing', 'No pool reservation covers this result, so no credit can be created.');
  return postTransaction(tx, {
    movement: 'accept_pending',
    transfers: [{ from: await creditAccount(tx, 'pool', o.swarmId, 'reserved'), to: await creditAccount(tx, 'account', o.accountId, 'pending'), amount: o.amount }],
    referenceType: 'verification_record',
    referenceId: o.verificationRecordId,
    idempotencyKey: `accept:${o.resultId}`,
    correlationId: o.leaseId,
  });
}

/** Pending credit for one result, from its accept entry (0 when it had none). */
export async function pendingForResult(tx: Exec, resultId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<string>`coalesce(sum(${ledgerEntries.creditCredits}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.idempotencyKey, `accept:${resultId}`));
  return Number(r?.n ?? 0);
}

/** Window closed clear (SPEC 9.2 step 5): pending becomes settled. No-op for impact-only results. */
export async function settleCredits(tx: Tx, o: { resultId: string; leaseId: string; accountId: string }) {
  const amount = await pendingForResult(tx, o.resultId);
  if (!amount) return null;
  return postTransaction(tx, {
    movement: 'settle',
    transfers: [{ from: await creditAccount(tx, 'account', o.accountId, 'pending'), to: await creditAccount(tx, 'account', o.accountId, 'settled'), amount }],
    referenceType: 'result',
    referenceId: o.resultId,
    idempotencyKey: `settle:${o.resultId}`,
    correlationId: o.leaseId,
  });
}

/** Fraud found while pending (SPEC 8.3, 9.2 step 6): the pending entry goes back to the pool. */
export async function clawbackCredits(tx: Tx, o: { resultId: string; leaseId: string; accountId: string; swarmId: string }) {
  const amount = await pendingForResult(tx, o.resultId);
  if (!amount) return null;
  return postTransaction(tx, {
    movement: 'clawback',
    transfers: [{ from: await creditAccount(tx, 'account', o.accountId, 'pending'), to: await creditAccount(tx, 'pool', o.swarmId, 'available'), amount }],
    referenceType: 'result',
    referenceId: o.resultId,
    idempotencyKey: `clawback:${o.resultId}`,
    correlationId: o.leaseId,
  });
}

/** A node account's balances (SPEC 13.4 wallet). Reserved is for own jobs, which arrive in M9. */
export async function accountBalances(tx: Exec, accountId: string) {
  const rows = await tx.select({ id: creditAccounts.id, bucket: creditAccounts.bucket }).from(creditAccounts).where(and(eq(creditAccounts.ownerType, 'account'), eq(creditAccounts.ownerId, accountId)));
  const out = { pending: 0, settled: 0, reserved: 0 };
  for (const r of rows) if (r.bucket === 'pending' || r.bucket === 'settled' || r.bucket === 'reserved') out[r.bucket] = await balance(tx, r.id);
  return out;
}

export type ReconcileReport = { ok: boolean; issues: string[]; accounts: number; transactions: number };

/**
 * Reconciliation (SPEC 9.5): every transaction balances, the whole ledger sums to zero, no bucket
 * other than `issued` is negative, pool caches equal their entries, and each account's pending
 * balance equals the accepted rewards of its results that are still pending.
 */
export async function reconcileLedger(tx: Exec): Promise<ReconcileReport> {
  const issues: string[] = [];
  const txns = await tx
    .select({ txnId: ledgerEntries.txnId, d: sql<string>`sum(${ledgerEntries.debitCredits})`, c: sql<string>`sum(${ledgerEntries.creditCredits})` })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.txnId);
  for (const t of txns) if (Number(t.d) !== Number(t.c)) issues.push(`transaction ${t.txnId} does not balance (${t.d} debited, ${t.c} credited)`);
  const accts = await tx.select().from(creditAccounts);
  let total = 0;
  const bal = new Map<string, number>();
  for (const a of accts) {
    const b = await balance(tx, a.id);
    bal.set(a.id, b);
    total += b;
    if (a.bucket !== 'issued' && b < 0) issues.push(`account ${a.id} (${a.ownerType} ${a.bucket}) is negative: ${b}`);
  }
  if (total !== 0) issues.push(`the ledger does not sum to zero (${total})`);
  for (const p of await tx.select().from(pools)) {
    const find = (bucket: Bucket) => accts.find((a) => a.ownerType === 'pool' && a.ownerId === p.swarmId && a.bucket === bucket);
    const available = bal.get(find('available')?.id ?? '') ?? 0;
    const reserved = bal.get(find('reserved')?.id ?? '') ?? 0;
    if (p.availableCached !== available) issues.push(`pool ${p.slug} available cache ${p.availableCached} != entries ${available}`);
    if (p.reservedCached !== reserved) issues.push(`pool ${p.slug} reserved cache ${p.reservedCached} != entries ${reserved}`);
  }
  // Pending balance per account equals the accept entries of its still-pending results.
  const accepts = await tx
    .select({ key: ledgerEntries.idempotencyKey, amount: ledgerEntries.creditCredits, correlation: ledgerEntries.correlationId })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.movementType, 'accept_pending'));
  const leaseIds = accepts.map((a) => a.correlation);
  const ls = leaseIds.length ? await tx.select({ id: leases.id, status: leases.status, accountId: leases.accountId }).from(leases).innerJoin(tasks, eq(tasks.id, leases.taskId)).where(inArray(leases.id, leaseIds)) : [];
  const expected = new Map<string, number>();
  for (const a of accepts) {
    const l = ls.find((x) => x.id === a.correlation);
    if (!l) {
      issues.push(`accept entry ${a.key} names no lease`);
      continue;
    }
    if (l.status === 'pending') expected.set(l.accountId, (expected.get(l.accountId) ?? 0) + a.amount);
  }
  for (const a of accts.filter((x) => x.ownerType === 'account' && x.bucket === 'pending')) {
    const want = expected.get(a.ownerId!) ?? 0;
    if ((bal.get(a.id) ?? 0) !== want) issues.push(`account ${a.ownerId} pending ${bal.get(a.id)} != pending results ${want}`);
  }
  return { ok: issues.length === 0, issues, accounts: accts.length, transactions: txns.length };
}
