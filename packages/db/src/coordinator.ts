/**
 * Hosted coordinator (SPEC 7, 13.3): task upload, leases with server deadlines, start, renew,
 * abandon, submit, expiry and requeue, and timeshare updates. Nodes always pull; nothing here ever
 * calls a node. Every state change runs in one transaction and follows the SPEC 7.3 diagram up to
 * `submitted`. Verification, pending and settled credit, and clawback live in verification.ts and
 * ledger.ts (M6); expiry, abandon and rejection release any pool reservation.
 *
 * Funding is stubbed as volunteer only: funded swarms lease nothing until publisher funding,
 * pool reservations and spend checks arrive (TODO M9).
 */
import { canTransitionLease, normalizeShares, sharesCustomized, TOTAL_SHARE_BP, type LeaseState } from '@swarm-explorer/core';
import { canonicalJson, type ManifestV1 } from '@swarm-explorer/schema';
import { sha256Digest } from '@swarm-explorer/schema/node';
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb, type Db } from './client';
import { releaseReservation } from './ledger';
import { MembershipError } from './membership';
import { recordReputation } from './reputation';
import { getSwarm, policyAccepts } from './queries';
import {
  deadlineMisses,
  harnessReleases,
  harnesses,
  leaseRules,
  leases,
  memberships,
  modelArtifacts,
  models,
  nodeModels,
  nodes,
  outboxEvents,
  permissionGrants,
  pools,
  publishers,
  results,
  revocations,
  runRecords,
  swarmReleases,
  swarms,
  taskKnownAnswers,
  tasks,
} from './schema';
import { currentVerificationRule } from './verification';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Lease = typeof leases.$inferSelect;
const OPEN = ['leased', 'running'] as const;

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) => new MembershipError(status, code, message, details);

function move(lease: Pick<Lease, 'status'>, to: LeaseState) {
  if (!canTransitionLease(lease.status as LeaseState, to)) throw err(409, 'invalid_transition', `A ${lease.status} lease cannot become ${to}.`);
}

async function outbox(tx: Tx, topic: string, payload: Record<string, unknown>) {
  await tx.insert(outboxEvents).values({ topic, payload });
}

/** The newest lease rule version for a swarm. With none stored, version 0: misses counted, no renewals. */
export async function currentLeaseRule(tx: Tx | Db, swarmId: string) {
  const [r] = await tx.select().from(leaseRules).where(eq(leaseRules.swarmId, swarmId)).orderBy(desc(leaseRules.version)).limit(1);
  return r ?? { version: 0, repeatedMissThreshold: null, maxRenewals: null, status: 'proposal' as const };
}

/**
 * Expires open leases past their server deadline and puts their tasks back in the queue (SPEC 7.3:
 * Leased or Running to Expired, then Requeued). Each miss is counted per node, swarm and lease rule
 * version. Reputation drops only when the swarm's lease rule has an approved repeated-miss threshold;
 * the seeded rules have none.
 */
export async function expireLeases(tx: Tx, now: Date, only?: { leaseId?: string }) {
  const due = await tx
    .select({ lease: leases, swarmId: tasks.swarmId })
    .from(leases)
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .where(and(inArray(leases.status, [...OPEN]), lt(leases.deadlineAt, now), only?.leaseId ? eq(leases.id, only.leaseId) : undefined));
  for (const { lease, swarmId } of due) {
    move(lease, 'expired');
    await tx.update(leases).set({ status: 'expired', expiredAt: now, requeuedAt: now }).where(eq(leases.id, lease.id));
    await tx.update(tasks).set({ status: 'queued' }).where(and(eq(tasks.id, lease.taskId), eq(tasks.status, 'leased')));
    const rule = await currentLeaseRule(tx, swarmId);
    const [miss] = await tx
      .insert(deadlineMisses)
      .values({ nodeId: lease.nodeId, swarmId, ruleVersion: rule.version, misses: 1, lastMissedAt: now })
      .onConflictDoUpdate({ target: [deadlineMisses.nodeId, deadlineMisses.swarmId, deadlineMisses.ruleVersion], set: { misses: sql`${deadlineMisses.misses} + 1`, lastMissedAt: now } })
      .returning({ misses: deadlineMisses.misses });
    // Repeated misses lower reputation only under an approved threshold (SPEC 7.3); null counts only.
    const threshold = rule.repeatedMissThreshold;
    if (threshold !== null && threshold > 0 && miss && miss.misses % threshold === 0)
      await recordReputation(tx, { accountId: lease.accountId, nodeId: lease.nodeId, swarmId, type: 'repeated_deadline_miss', evidenceRef: `misses:${lease.nodeId}:${swarmId}:${rule.version}:${miss.misses}` });
    // A pool reservation, if this lease had one, returns to the pool (SPEC 9.5).
    await releaseReservation(tx, { leaseId: lease.id, swarmId });
    await outbox(tx, 'lease.expired', { lease_id: lease.id, task_id: lease.taskId, node_id: lease.nodeId });
  }
  return due.length;
}

/** Sweeps every expired lease. The API also sweeps lazily on each lease call, so no timer is required. */
export async function sweepExpiredLeases(now = new Date()) {
  const db = await getDb();
  return db.transaction((tx) => expireLeases(tx, now));
}

/* ----------------------------------------------------------------------------
 * Task upload (SPEC 13.4 tasks:batch, hosted coordinator)
 * ------------------------------------------------------------------------- */

export type TaskUpload = { coordinator_task_id: string; input: Record<string, unknown>; urgent?: boolean; known_answer?: Record<string, unknown> };

/** The publisher's owner uploads tasks for a listed swarm. Idempotent by coordinator task id. */
export async function uploadTasks(o: { accountId: string; slug: string; tasks: TaskUpload[] }) {
  const s = await getSwarm(o.slug);
  if (!s) throw err(404, 'not_found', 'No listed swarm with that id.');
  const db = await getDb();
  const [pub] = await db.select({ owner: publishers.ownerAccountId }).from(publishers).where(eq(publishers.id, s.swarm.publisherId));
  if (pub?.owner !== o.accountId) throw err(403, 'forbidden', 'Only the publisher can upload tasks for this swarm.');
  if (s.manifest.coordinator.mode !== 'hosted') throw err(409, 'self_hosted_coordinator', 'This swarm runs its own coordinator.');
  if (o.tasks.some((t) => t.urgent) && !s.manifest.task.urgent_allowed) throw err(422, 'urgent_not_allowed', 'This swarm does not allow urgent tasks.');
  const methods = s.manifest.verification as string[];
  if (o.tasks.some((t) => t.known_answer) && !methods.includes('known-answers')) throw err(422, 'known_answers_not_used', 'This swarm does not verify with known answers.');
  // Redundancy sends each task to N independent nodes. N has no default (SPEC 8.1): without an
  // approved count the coordinator refuses the upload rather than invent one.
  const rule = methods.includes('redundancy') ? await currentVerificationRule(db, s.swarm.id) : null;
  if (rule && rule.redundancyCount === null) throw err(409, 'redundancy_unconfigured', 'This swarm has no redundancy count configured yet.');
  const copies = rule?.redundancyCount ?? 1;
  const reward = s.manifest.credits.funded ? (s.manifest.credits.per_accepted_task ?? null) : null;
  const rows = o.tasks.flatMap((t) =>
    Array.from({ length: copies }, (_, i) => ({
      swarmId: s.swarm.id,
      releaseId: s.release.id,
      coordinatorTaskId: copies > 1 ? `${t.coordinator_task_id}:r${i + 1}` : t.coordinator_task_id,
      inputRef: `coordinator:${s.swarm.slug}/${t.coordinator_task_id}`,
      inputHash: sha256Digest(canonicalJson(t.input)),
      inputJson: t.input,
      modelRequirementJson: { policy: s.manifest.models.policy, allowed_classes: modelClasses(s.manifest) },
      urgent: Boolean(t.urgent),
      rewardCredits: reward,
      redundancyGroup: copies > 1 ? t.coordinator_task_id : null,
    })),
  );
  return db.transaction(async (tx) => {
    const inserted = rows.length ? await tx.insert(tasks).values(rows).onConflictDoNothing().returning({ id: tasks.id, coordinatorTaskId: tasks.coordinatorTaskId }) : [];
    // Hidden known answers sit apart from the task, so no task view can reveal which tasks are known.
    const known = new Map(o.tasks.filter((t) => t.known_answer).map((t) => [t.coordinator_task_id, t.known_answer!]));
    const answers = inserted.flatMap((r) => (known.has(r.coordinatorTaskId) ? [{ taskId: r.id, expectedJson: known.get(r.coordinatorTaskId)! }] : []));
    if (answers.length) await tx.insert(taskKnownAnswers).values(answers);
    return { accepted: inserted.length / copies, duplicates: (rows.length - inserted.length) / copies };
  });
}

function modelClasses(m: ManifestV1): string[] {
  return m.models.class ? [m.models.class] : (m.models.allowed_classes ?? []);
}

/* ----------------------------------------------------------------------------
 * Leases (SPEC 13.3)
 * ------------------------------------------------------------------------- */

export type LeaseUnavailable = 'no_tasks' | 'pool_empty' | 'paid_leasing_unavailable';

export type LeaseGrant = {
  lease: Lease;
  taskId: string;
  swarm: string;
  releaseId: string;
  harness: { version: string; hash: string };
  modelRequirement: { policy: 'any' | 'class' | 'diverse'; allowed_classes: string[] };
  inputHash: string;
  outputSchemaHash: string;
  permissionsHash: string;
  reward: { funded: true; credits: number } | { funded: false; credits: null };
};

async function revoked(tx: Tx, ids: string[], now: Date) {
  const rows = await tx
    .select({ id: revocations.id })
    .from(revocations)
    .where(and(inArray(revocations.targetId, ids), lt(revocations.effectiveAt, new Date(now.getTime() + 1))))
    .limit(1);
  return rows.length > 0;
}

/** Models on this node that the swarm's policy accepts, by pinned hash (SPEC 6.2). */
async function acceptedModel(tx: Tx, nodeId: string, manifest: ManifestV1, artifactHash: string) {
  const [row] = await tx
    .select({ modelClass: models.modelClass })
    .from(nodeModels)
    .innerJoin(modelArtifacts, eq(modelArtifacts.id, nodeModels.modelArtifactId))
    .innerJoin(models, eq(models.id, modelArtifacts.modelId))
    .where(and(eq(nodeModels.nodeId, nodeId), eq(modelArtifacts.contentHash, artifactHash), eq(models.reviewStatus, 'approved')))
    .limit(1);
  return Boolean(row && policyAccepts(manifest, row.modelClass));
}

const notEligible: Record<string, string> = {
  joining: 'Approve this swarm’s permissions first.',
  qualifying: 'Pass this swarm’s qualification first.',
  reconsent_required: 'A new release changed this swarm’s permissions. Approve them to continue.',
  paused: 'This swarm is paused on this node.',
};

/**
 * A node asks for work (SPEC 13.3 `POST /coordinators/{swarm}/leases`). Returns zero or one lease.
 * Eligibility (SPEC 7.1): listed swarm, no kill switch or revocation, hosted coordinator, an active
 * qualified membership with the current permissions granted, an accepted model the node holds, and a
 * free concurrency slot. Urgent tasks are leased first. Funded swarms lease nothing yet (TODO M9).
 */
export async function requestLease(o: { accountId: string; nodeId: string; slug: string; modelArtifactHash: string; idempotencyKey: string; now?: Date }): Promise<{ grant: LeaseGrant | null; reason: LeaseUnavailable | null }> {
  const now = o.now ?? new Date();
  const s = await getSwarm(o.slug);
  if (!s) throw err(409, 'swarm_unavailable', 'This swarm is not taking work right now.');
  const m = s.manifest;
  const db = await getDb();
  return db.transaction(async (tx) => {
    if (await revoked(tx, [s.swarm.id, s.swarm.slug, s.release.id, s.harnessRelease.id, s.harnessRelease.bundleHash], now)) throw err(409, 'revoked', 'This swarm or its harness was revoked.');
    if (s.harnessRelease.reviewStatus !== 'approved' || s.harnessRelease.revokedAt) throw err(409, 'release_revoked', 'This harness release is not available.');
    if (s.harnessRelease.runtime !== 'wasm') throw err(409, 'runtime_unsupported', 'This harness needs isolation this version of Henge does not provide.');
    if (m.coordinator.mode !== 'hosted') throw err(409, 'self_hosted_coordinator', 'This swarm runs its own coordinator.');

    await expireLeases(tx, now);

    const [mem] = await tx
      .select({ membership: memberships, release: swarmReleases })
      .from(memberships)
      .innerJoin(swarmReleases, eq(swarmReleases.id, memberships.releaseId))
      .where(and(eq(memberships.nodeId, o.nodeId), eq(memberships.swarmId, s.swarm.id), isNull(memberships.leftAt)))
      .limit(1);
    if (!mem) throw err(409, 'not_a_member', 'This node has not joined this swarm.');
    if (mem.membership.status !== 'active') throw err(409, 'not_eligible', notEligible[mem.membership.status] ?? 'This membership cannot take work.', { status: mem.membership.status });
    const [grant] = await tx
      .select({ hash: permissionGrants.permissionsHash })
      .from(permissionGrants)
      .where(and(eq(permissionGrants.membershipId, mem.membership.id), eq(permissionGrants.releaseId, mem.release.id), isNull(permissionGrants.revokedAt)))
      .limit(1);
    if (!grant || grant.hash !== mem.release.permissionsHash) throw err(409, 'permissions_required', 'Approve this swarm’s permissions first.');
    if (!(await acceptedModel(tx, o.nodeId, m, o.modelArtifactHash))) throw err(409, 'policy_mismatch', 'This swarm does not accept that model, or it is not on this node.');

    // Local GPU concurrency defaults to one lease per node (SPEC 7.3), and the swarm's own cap applies too.
    const [node] = await tx.select({ concurrency: nodes.concurrencyLocal }).from(nodes).where(eq(nodes.id, o.nodeId));
    const open = await tx.select({ lease: leases, swarmId: tasks.swarmId }).from(leases).innerJoin(tasks, eq(tasks.id, leases.taskId)).where(and(eq(leases.nodeId, o.nodeId), inArray(leases.status, [...OPEN])));
    if (open.length >= (node?.concurrency ?? 1)) throw err(409, 'concurrency_limit', 'This node already holds as many leases as it runs at once.', { open_leases: open.map((l) => l.lease.id) });
    if (open.filter((l) => l.swarmId === s.swarm.id).length >= m.task.max_parallel_per_node) throw err(409, 'concurrency_limit', 'This swarm allows no more parallel tasks on one node.');

    if (m.credits.funded) {
      // TODO M9: reserve pool credits and check spend reservations before a paid lease. Until then
      // the coordinator leases volunteer work only.
      const [pool] = await tx.select({ available: pools.availableCached }).from(pools).where(eq(pools.swarmId, s.swarm.id));
      return { grant: null, reason: !pool || pool.available <= 0 ? 'pool_empty' : 'paid_leasing_unavailable' };
    }

    // Tasks from any reviewed release with the same harness and the same permissions the node approved.
    const candidates = await tx
      .select({ task: tasks, release: swarmReleases })
      .from(tasks)
      .innerJoin(swarmReleases, eq(swarmReleases.id, tasks.releaseId))
      .where(
        and(
          eq(tasks.swarmId, s.swarm.id),
          eq(tasks.status, 'queued'),
          eq(swarmReleases.reviewStatus, 'approved'),
          isNull(swarmReleases.revokedAt),
          eq(swarmReleases.permissionsHash, mem.release.permissionsHash),
          eq(swarmReleases.harnessReleaseId, mem.release.harnessReleaseId),
        ),
      )
      .orderBy(desc(tasks.urgent), asc(tasks.createdAt), asc(tasks.id))
      .limit(8);
    for (const c of candidates) {
      // Redundancy replicas go to independent accounts: never two replicas of one task to one account (SPEC 8.3).
      if (c.task.redundancyGroup) {
        const mine = await tx
          .select({ id: leases.id })
          .from(leases)
          .innerJoin(tasks, eq(tasks.id, leases.taskId))
          .where(and(eq(tasks.swarmId, s.swarm.id), eq(tasks.redundancyGroup, c.task.redundancyGroup), eq(leases.accountId, o.accountId)))
          .limit(1);
        if (mine.length) continue;
      }
      const claimed = await tx.update(tasks).set({ status: 'leased' }).where(and(eq(tasks.id, c.task.id), eq(tasks.status, 'queued'))).returning({ id: tasks.id });
      if (!claimed.length) continue;
      const [lease] = await tx
        .insert(leases)
        .values({
          taskId: c.task.id,
          nodeId: o.nodeId,
          accountId: o.accountId,
          membershipId: mem.membership.id,
          urgent: c.task.urgent,
          deadlineAt: new Date(now.getTime() + m.task.timeout_s * 1000),
          idempotencyKey: o.idempotencyKey,
          leasedAt: now,
        })
        .returning();
      await outbox(tx, 'lease.created', { lease_id: lease!.id, task_id: c.task.id, node_id: o.nodeId, swarm: s.swarm.slug });
      return { grant: await grantView(tx, lease!), reason: null };
    }
    return { grant: null, reason: 'no_tasks' };
  });
}

async function grantView(tx: Tx | Db, lease: Lease): Promise<LeaseGrant> {
  const [r] = await tx
    .select({ task: tasks, release: swarmReleases, swarm: swarms, hr: harnessReleases })
    .from(tasks)
    .innerJoin(swarmReleases, eq(swarmReleases.id, tasks.releaseId))
    .innerJoin(swarms, eq(swarms.id, tasks.swarmId))
    .innerJoin(harnessReleases, eq(harnessReleases.id, swarmReleases.harnessReleaseId))
    .where(eq(tasks.id, lease.taskId));
  const m = r!.release.manifestJson as ManifestV1;
  return {
    lease,
    taskId: r!.task.id,
    swarm: r!.swarm.slug,
    releaseId: r!.release.id,
    harness: { version: m.harness.version, hash: m.harness.hash },
    modelRequirement: { policy: m.models.policy, allowed_classes: modelClasses(m) },
    inputHash: r!.task.inputHash,
    outputSchemaHash: r!.hr.outputSchemaHash,
    permissionsHash: r!.release.permissionsHash,
    reward: r!.task.rewardCredits ? { funded: true, credits: r!.task.rewardCredits } : { funded: false, credits: null },
  };
}

/** The caller's lease. Someone else's lease looks the same as a missing one. */
async function ownedLease(tx: Tx, accountId: string, leaseId: string): Promise<Lease> {
  const [l] = await tx.select().from(leases).where(eq(leases.id, leaseId)).limit(1);
  if (!l || l.accountId !== accountId) throw err(404, 'not_found', 'No such lease.');
  return l;
}

async function leaseFacts(tx: Tx, lease: Lease) {
  const [r] = await tx
    .select({ task: tasks, release: swarmReleases })
    .from(tasks)
    .innerJoin(swarmReleases, eq(swarmReleases.id, tasks.releaseId))
    .where(eq(tasks.id, lease.taskId));
  return { task: r!.task, release: r!.release, manifest: r!.release.manifestJson as ManifestV1 };
}

/** Expires this one lease if its deadline passed, then reloads it. */
async function fresh(tx: Tx, lease: Lease, now: Date): Promise<Lease> {
  if (!(OPEN as readonly string[]).includes(lease.status) || lease.deadlineAt >= now) return lease;
  await expireLeases(tx, now, { leaseId: lease.id });
  const [l] = await tx.select().from(leases).where(eq(leases.id, lease.id));
  return l!;
}

/**
 * Leased to Running (SPEC 7.3): the node reports the pins it verified. The coordinator checks them
 * against the task's release, then hands out the input. A mismatch leaves the lease leased; the node
 * abandons it.
 */
export async function startLease(o: { accountId: string; leaseId: string; pins: { harnessHash: string; permissionsHash: string; modelArtifactHash: string }; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const lease = await fresh(tx, await ownedLease(tx, o.accountId, o.leaseId), now);
    if (lease.status === 'expired') throw err(409, 'lease_expired', 'This lease passed its deadline and went back to the queue.');
    if (lease.status === 'abandoned') throw err(409, 'lease_abandoned', 'This lease was abandoned.');
    const f = await leaseFacts(tx, lease);
    if (lease.status === 'running') return { lease, input: f.task.inputJson as Record<string, unknown> | null, inputHash: f.task.inputHash };
    if (o.pins.harnessHash !== f.manifest.harness.hash || o.pins.permissionsHash !== f.release.permissionsHash)
      throw err(409, 'pin_mismatch', 'The harness or permissions on this node do not match this task.', { harness_hash: f.manifest.harness.hash, permissions_hash: f.release.permissionsHash });
    if (!(await acceptedModel(tx, lease.nodeId, f.manifest, o.pins.modelArtifactHash))) throw err(409, 'pin_mismatch', 'This swarm does not accept that model.');
    move(lease, 'running');
    const [updated] = await tx.update(leases).set({ status: 'running', startedAt: now }).where(eq(leases.id, lease.id)).returning();
    return { lease: updated!, input: f.task.inputJson as Record<string, unknown> | null, inputHash: f.task.inputHash };
  });
}

/** The task input, only while the lease is running and before its deadline. */
export async function leaseInput(o: { accountId: string; leaseId: string; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const lease = await fresh(tx, await ownedLease(tx, o.accountId, o.leaseId), now);
    if (lease.status !== 'running') throw err(409, 'lease_not_running', 'The input is available only while this lease is running.');
    const f = await leaseFacts(tx, lease);
    if (!f.task.inputJson) throw err(409, 'input_unavailable', 'This task input is not stored on the hosted coordinator.');
    return { input: f.task.inputJson as Record<string, unknown>, inputHash: f.task.inputHash };
  });
}

/**
 * Renewal (SPEC 7.3): only before the deadline, and only as many times as the swarm's lease rule
 * allows. With no approved number the coordinator refuses, which the spec permits.
 */
export async function renewLease(o: { accountId: string; leaseId: string; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const lease = await fresh(tx, await ownedLease(tx, o.accountId, o.leaseId), now);
    if (lease.status === 'expired') throw err(409, 'lease_expired', 'This lease passed its deadline and went back to the queue.');
    if (!(OPEN as readonly string[]).includes(lease.status)) throw err(409, 'lease_closed', `This lease is ${lease.status}.`);
    const f = await leaseFacts(tx, lease);
    const rule = await currentLeaseRule(tx, f.task.swarmId);
    if (rule.maxRenewals === null || lease.renewals >= rule.maxRenewals) throw err(409, 'renewal_refused', 'The coordinator did not renew this lease.', { deadline_at: lease.deadlineAt.toISOString() });
    const [updated] = await tx
      .update(leases)
      .set({ deadlineAt: new Date(now.getTime() + f.manifest.task.timeout_s * 1000), renewals: lease.renewals + 1 })
      .where(eq(leases.id, lease.id))
      .returning();
    return updated!;
  });
}

/**
 * Abandon (SPEC 7.3): an immediate unpaid return from Pause, leave, a run rule stop or a local
 * failure. The task goes straight back to the queue. Repeating it is harmless.
 */
export async function abandonLease(o: { accountId: string; leaseId: string; reason: string; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const lease = await fresh(tx, await ownedLease(tx, o.accountId, o.leaseId), now);
    if (lease.status === 'abandoned' || lease.status === 'expired') return lease;
    if (!(OPEN as readonly string[]).includes(lease.status)) throw err(409, 'already_submitted', 'This lease already has a result.');
    // SPEC 7.3 has no Leased to Abandoned edge. A lease handed back before it started (Pause right
    // after leasing) is treated as Running then Abandoned: unpaid, requeued, never counted as a miss.
    if (lease.status === 'running') move(lease, 'abandoned');
    const [updated] = await tx.update(leases).set({ status: 'abandoned', abandonedAt: now, requeuedAt: now }).where(eq(leases.id, lease.id)).returning();
    await tx.update(tasks).set({ status: 'queued' }).where(and(eq(tasks.id, lease.taskId), eq(tasks.status, 'leased')));
    const [t] = await tx.select({ swarmId: tasks.swarmId }).from(tasks).where(eq(tasks.id, lease.taskId));
    await releaseReservation(tx, { leaseId: lease.id, swarmId: t!.swarmId });
    await outbox(tx, 'lease.abandoned', { lease_id: lease.id, task_id: lease.taskId, node_id: lease.nodeId, reason: o.reason });
    return updated!;
  });
}

export type RunRecordRow = {
  modelIdClaim: string;
  modelArtifactHash: string | null;
  provider: string | null;
  harnessHash: string;
  tokensIn: number | null;
  tokensOut: number | null;
  elapsedMs: number;
  costUsdMicrosReported: number | null;
  signature: string;
  record: Record<string, unknown>;
};

/**
 * Submit (SPEC 7.3, 13.3). Idempotent by lease and result hash. A different result for the same
 * lease is refused. A result after expiry or abandonment is recorded and never paid; an on-time one
 * moves the lease to Submitted, where verification intake picks it up. The caller verifies the output hash
 * and the run record's device signature first.
 */
export async function submitResult(o: { accountId: string; leaseId: string; output: Record<string, unknown>; outputHash: string; schemaValid: boolean | null; run: RunRecordRow; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    let lease = await ownedLease(tx, o.accountId, o.leaseId);
    const prior = await tx.select().from(results).where(eq(results.leaseId, lease.id));
    const same = prior.find((r) => r.outputHash === o.outputHash);
    if (same) return { lease, result: same, duplicate: true };
    if (prior.length) throw err(409, 'already_submitted', 'This lease already has a different result.');
    if (lease.status === 'leased') throw err(409, 'lease_not_running', 'Start the lease before submitting a result.');
    // A device signature is accepted once: replaying a run record from another lease is refused (SPEC 8.3).
    const [replayed] = await tx.select({ leaseId: runRecords.leaseId }).from(runRecords).where(eq(runRecords.runRecordSignature, o.run.signature)).limit(1);
    if (replayed && replayed.leaseId !== lease.id) throw err(409, 'run_record_replayed', 'That run record was already used for another lease.');
    lease = await fresh(tx, lease, now);
    const disposition = lease.status === 'running' ? 'on_time' : lease.status === 'expired' ? 'late' : lease.status === 'abandoned' ? 'after_abandon' : null;
    if (!disposition) throw err(409, 'lease_closed', `This lease is ${lease.status}.`);
    const [result] = await tx
      .insert(results)
      .values({ leaseId: lease.id, outputRef: `coordinator:results/${lease.id}`, outputHash: o.outputHash, schemaValid: o.schemaValid, outputJson: o.output, disposition, submittedAt: now })
      .returning();
    await tx
      .insert(runRecords)
      .values({
        leaseId: lease.id,
        modelIdClaim: o.run.modelIdClaim,
        modelArtifactHash: o.run.modelArtifactHash,
        provider: o.run.provider,
        harnessHash: o.run.harnessHash,
        tokensIn: o.run.tokensIn,
        tokensOut: o.run.tokensOut,
        elapsedMs: o.run.elapsedMs,
        costUsdMicrosReported: o.run.costUsdMicrosReported,
        runRecordSignature: o.run.signature,
        recordJson: o.run.record,
      })
      .onConflictDoNothing();
    if (disposition === 'on_time') {
      move(lease, 'submitted');
      const [submitted] = await tx.update(leases).set({ status: 'submitted', submittedAt: now }).where(eq(leases.id, lease.id)).returning();
      await tx.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, lease.taskId));
      await outbox(tx, 'result.submitted', { lease_id: lease.id, result_id: result!.id, output_sha256: o.outputHash });
      lease = submitted!;
    }
    return { lease, result: result!, duplicate: false };
  });
}

/** Status for recovery (SPEC 13.3 `GET /leases/{id}`). Sweeps an expired lease first. */
export async function getLease(o: { accountId: string; leaseId: string; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const lease = await fresh(tx, await ownedLease(tx, o.accountId, o.leaseId), now);
    const [result] = await tx.select().from(results).where(eq(results.leaseId, lease.id)).orderBy(asc(results.submittedAt)).limit(1);
    return { grant: await grantView(tx, lease), result: result ?? null };
  });
}

/** Queued and urgent task counts per swarm, so a node's scheduler knows where work waits. */
/**
 * Queued tasks each membership could lease: same swarm, and a task release with the same harness
 * and permissions as the membership's release (what requestLease matches on). Keyed by swarm id,
 * since a node has one membership per swarm.
 */
export async function queueCounts(list: Array<{ swarmId: string; harnessReleaseId: string; permissionsHash: string }>) {
  const out = new Map<string, { queued: number; urgent: number }>();
  if (!list.length) return out;
  const db = await getDb();
  for (const m of list) {
    const rows = await db
      .select({ urgent: tasks.urgent, n: count() })
      .from(tasks)
      .innerJoin(swarmReleases, eq(swarmReleases.id, tasks.releaseId))
      .where(and(eq(tasks.swarmId, m.swarmId), eq(tasks.status, 'queued'), eq(swarmReleases.harnessReleaseId, m.harnessReleaseId), eq(swarmReleases.permissionsHash, m.permissionsHash)))
      .groupBy(tasks.urgent);
    const c = { queued: 0, urgent: 0 };
    for (const r of rows) {
      c.queued += Number(r.n);
      if (r.urgent) c.urgent += Number(r.n);
    }
    out.set(m.swarmId, c);
  }
  return out;
}

/** Open leases on a node, for store home and recovery after a restart. */
export async function openLeases(nodeId: string) {
  const db = await getDb();
  return db
    .select({ id: leases.id, status: leases.status, deadlineAt: leases.deadlineAt, swarm: swarms.slug })
    .from(leases)
    .innerJoin(tasks, eq(tasks.id, leases.taskId))
    .innerJoin(swarms, eq(swarms.id, tasks.swarmId))
    .where(and(eq(leases.nodeId, nodeId), or(eq(leases.status, 'leased'), eq(leases.status, 'running'))));
}

/* ----------------------------------------------------------------------------
 * Timeshare (SPEC 7.1, 13.2 `PATCH /nodes/{id}/shares`)
 * ------------------------------------------------------------------------- */

const QUALIFIED = ['active', 'paused', 'reconsent_required'] as const;

/**
 * Atomically sets a node's shares. Every qualified membership must be named once and the basis
 * points must sum to exactly 10,000. Equal shares clear the customized flag, so later joins
 * rebalance without asking again.
 */
export async function setShares(o: { accountId: string; nodeId: string; shares: Array<{ membershipId: string; shareBp: number }> }) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.nodeId, o.nodeId), eq(memberships.accountId, o.accountId), isNull(memberships.leftAt), inArray(memberships.status, [...QUALIFIED])))
      .orderBy(asc(memberships.joinedAt), asc(memberships.id));
    const want = new Set(rows.map((r) => r.id));
    const given = new Map(o.shares.map((s) => [s.membershipId, s.shareBp]));
    const sum = o.shares.reduce((a, s) => a + s.shareBp, 0);
    if (given.size !== o.shares.length || given.size !== want.size || [...given.keys()].some((k) => !want.has(k)))
      throw err(422, 'shares_invalid', 'Name every qualified swarm on this node exactly once.', { membership_ids: [...want] });
    if (o.shares.some((s) => !Number.isInteger(s.shareBp) || s.shareBp < 0 || s.shareBp > TOTAL_SHARE_BP) || sum !== TOTAL_SHARE_BP)
      throw err(422, 'shares_invalid', 'Shares must be whole basis points that sum to 10,000.', { sum });
    for (const [id, bp] of given) await tx.update(memberships).set({ shareBp: bp }).where(eq(memberships.id, id));
    const ordered = rows.map((r) => given.get(r.id)!);
    const customized = sharesCustomized(ordered);
    await tx.update(nodes).set({ sharesCustomized: customized }).where(eq(nodes.id, o.nodeId));
    return { customized, shares: rows.map((r) => ({ membershipId: r.id, shareBp: given.get(r.id)! })) };
  });
}

/**
 * Rebalances after a join or leave (SPEC 7.1). Uncustomized shares stay equal. Customized shares
 * are never equalized without asking: a newly qualified swarm starts at 0 (it can still borrow lent
 * time) and the node is asked; a share given up on leave is spread in proportion.
 */
export async function rebalanceShares(tx: Tx, nodeId: string) {
  const rows = await tx
    .select({ id: memberships.id, shareBp: memberships.shareBp })
    .from(memberships)
    .where(and(eq(memberships.nodeId, nodeId), isNull(memberships.leftAt), inArray(memberships.status, [...QUALIFIED])))
    .orderBy(asc(memberships.joinedAt), asc(memberships.id));
  const [node] = await tx.select({ customized: nodes.sharesCustomized }).from(nodes).where(eq(nodes.id, nodeId));
  const shares = node?.customized ? normalizeShares(rows.map((r) => r.shareBp)) : normalizeShares(rows.map(() => 1));
  for (const [i, r] of rows.entries()) await tx.update(memberships).set({ shareBp: shares[i]! }).where(eq(memberships.id, r.id));
  await tx
    .update(memberships)
    .set({ shareBp: 0 })
    .where(and(eq(memberships.nodeId, nodeId), inArray(memberships.status, ['joining', 'qualifying', 'left'])));
}

/** Harness names per swarm release, for bundle lookups in the API. */
export async function harnessForRelease(releaseId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ name: harnesses.name, hr: harnessReleases })
    .from(swarmReleases)
    .innerJoin(harnessReleases, eq(harnessReleases.id, swarmReleases.harnessReleaseId))
    .innerJoin(harnesses, eq(harnesses.id, harnessReleases.harnessId))
    .where(eq(swarmReleases.id, releaseId));
  return r ?? null;
}
