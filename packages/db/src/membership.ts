/**
 * Join, consent, qualification, leave and release review (SPEC 3.2, 4.2, 11.4, 13.2). Every state
 * change runs in one transaction. Qualification is known-answer only and never creates ledger
 * entries: it is not credited work.
 */
import { canonicalJson, type ManifestV1 } from '@swarm-explorer/schema';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, type Db } from './client';
import { rebalanceShares as rebalance } from './coordinator';
import { rescoreQualification } from './verification';
import { MembershipError } from './errors';
import { assertWorkAllowed } from './kill-switch';
import { getSwarm, policyAccepts, type SwarmRow } from './queries';
import {
  harnessReleases,
  leases,
  memberships,
  modelArtifacts,
  models,
  nodeModels,
  permissionGrants,
  qualificationAttempts,
  qualifications,
  qualificationTasks,
  reviews,
  swarmReleases,
  swarms,
  tasks,
} from './schema';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Membership = typeof memberships.$inferSelect;

export { MembershipError } from './errors';

async function ownedMembership(tx: Tx, accountId: string, membershipId: string): Promise<Membership> {
  const [m] = await tx.select().from(memberships).where(eq(memberships.id, membershipId)).limit(1);
  // Someone else's membership looks the same as a missing one.
  if (!m || m.accountId !== accountId) throw new MembershipError(404, 'not_found', 'No such membership.');
  if (m.leftAt) throw new MembershipError(409, 'membership_left', 'You left this swarm. Join again to take part.');
  return m;
}

async function release(tx: Tx, releaseId: string) {
  const [r] = await tx.select().from(swarmReleases).where(eq(swarmReleases.id, releaseId)).limit(1);
  if (!r) throw new MembershipError(404, 'not_found', 'No such release.');
  return { ...r, manifest: r.manifestJson as ManifestV1 };
}

/** The node's installed models that this swarm's model policy accepts (SPEC 6.2). */
export async function qualifyingModels(nodeId: string, manifest: ManifestV1) {
  const db = await getDb();
  const rows = await db
    .select({ hash: modelArtifacts.contentHash, slug: models.slug, displayName: models.displayName, modelClass: models.modelClass })
    .from(nodeModels)
    .innerJoin(modelArtifacts, eq(modelArtifacts.id, nodeModels.modelArtifactId))
    .innerJoin(models, eq(models.id, modelArtifacts.modelId))
    .where(and(eq(nodeModels.nodeId, nodeId), eq(models.reviewStatus, 'approved')));
  return rows.filter((r) => policyAccepts(manifest, r.modelClass));
}

export type JoinStart = { membership: Membership; swarm: SwarmRow; resumed: boolean };

/**
 * Starts a join for one node and the swarm's current reviewed release. Refuses a stale release,
 * an unrunnable harness, and a node with no model the policy accepts.
 */
export async function startJoin(o: { accountId: string; nodeId: string; slug: string; manifestHash: string }): Promise<JoinStart> {
  const swarm = await getSwarm(o.slug);
  if (!swarm) throw new MembershipError(404, 'not_found', 'No listed swarm with that id.');
  if (swarm.release.manifestHash !== o.manifestHash)
    throw new MembershipError(409, 'release_changed', 'This swarm has a newer reviewed release. Review it before joining.', { manifest_hash: swarm.release.manifestHash });
  const hr = swarm.harnessRelease;
  if (hr.reviewStatus !== 'approved' || hr.revokedAt) throw new MembershipError(409, 'release_revoked', 'This harness release is not available.');
  if (hr.runtime !== 'wasm') throw new MembershipError(409, 'runtime_unsupported', 'This harness needs isolation this version of Henge does not provide.');
  const fit = await qualifyingModels(o.nodeId, swarm.manifest);
  if (fit.length === 0) throw new MembershipError(409, 'policy_mismatch', 'None of your models is accepted by this swarm. Download one it accepts, then try again.');

  const db = await getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.nodeId, o.nodeId), eq(memberships.swarmId, swarm.swarm.id), isNull(memberships.leftAt)))
      .limit(1);
    if (existing) {
      if (existing.status === 'joining' || existing.status === 'qualifying') {
        // A join in progress on an older release restarts on the current one.
        if (existing.releaseId !== swarm.release.id) {
          await tx.update(memberships).set({ releaseId: swarm.release.id, status: 'joining' }).where(eq(memberships.id, existing.id));
          await tx.update(permissionGrants).set({ revokedAt: new Date() }).where(and(eq(permissionGrants.membershipId, existing.id), isNull(permissionGrants.revokedAt)));
          return { membership: { ...existing, releaseId: swarm.release.id, status: 'joining' as const }, swarm, resumed: true };
        }
        return { membership: existing, swarm, resumed: true };
      }
      throw new MembershipError(409, 'already_member', 'This node already belongs to this swarm.');
    }
    const [m] = await tx.insert(memberships).values({ accountId: o.accountId, nodeId: o.nodeId, swarmId: swarm.swarm.id, releaseId: swarm.release.id }).returning();
    return { membership: m!, swarm, resumed: false };
  });
}

/**
 * Records approval of an exact permissions hash (SPEC 13.2, 11.4). A changed release must be
 * approved again: a hash that does not match the release the membership is moving to is refused.
 */
export async function grantPermissions(o: { accountId: string; membershipId: string; permissionsHash: string }) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const m = await ownedMembership(tx, o.accountId, o.membershipId);
    let target = await release(tx, m.releaseId);
    if (m.status === 'reconsent_required') {
      const current = await getSwarmById(tx, m.swarmId);
      if (!current) throw new MembershipError(409, 'swarm_unavailable', 'This swarm is not listed right now.');
      target = current;
    } else if (m.status !== 'joining' && m.status !== 'qualifying') {
      throw new MembershipError(409, 'nothing_to_approve', 'These permissions are already approved.');
    }
    if (target.permissionsHash !== o.permissionsHash)
      throw new MembershipError(409, 'permissions_changed', 'The permissions changed. Review them again.', { permissions_hash: target.permissionsHash });

    const now = new Date();
    await tx.update(permissionGrants).set({ revokedAt: now }).where(and(eq(permissionGrants.membershipId, m.id), isNull(permissionGrants.revokedAt)));
    const [grant] = await tx
      .insert(permissionGrants)
      .values({ membershipId: m.id, releaseId: target.id, permissionsHash: target.permissionsHash, grantedJson: target.manifest.permissions })
      .returning();
    const status = m.status === 'reconsent_required' ? ('active' as const) : ('qualifying' as const);
    await tx.update(memberships).set({ status, releaseId: target.id }).where(eq(memberships.id, m.id));
    return { grant: grant!, status, releaseId: target.id };
  });
}

/** The newest approved, unrevoked release of a listed swarm, by swarm id. */
async function getSwarmById(tx: Tx, swarmId: string) {
  const [s] = await tx.select({ status: swarms.status }).from(swarms).where(eq(swarms.id, swarmId)).limit(1);
  if (!s || s.status !== 'listed') return null;
  const [r] = await tx
    .select()
    .from(swarmReleases)
    .where(and(eq(swarmReleases.swarmId, swarmId), eq(swarmReleases.reviewStatus, 'approved'), isNull(swarmReleases.revokedAt)))
    .orderBy(desc(swarmReleases.publishedAt))
    .limit(1);
  return r ? { ...r, manifest: r.manifestJson as ManifestV1 } : null;
}

async function requireGrant(tx: Tx, m: Membership) {
  const rel = await release(tx, m.releaseId);
  const [g] = await tx
    .select()
    .from(permissionGrants)
    .where(and(eq(permissionGrants.membershipId, m.id), eq(permissionGrants.releaseId, m.releaseId), isNull(permissionGrants.revokedAt)))
    .limit(1);
  if (!g || g.permissionsHash !== rel.permissionsHash) throw new MembershipError(409, 'permissions_required', 'Approve this swarm’s permissions first.');
  return rel;
}

export type QualificationProgress = {
  id: string;
  tasks: number;
  pass: number;
  attempts: number;
  passed: number;
  outcome: 'in_progress' | 'passed' | 'failed';
  retryReason: string | null;
};

function progress(q: typeof qualifications.$inferSelect, rule: { tasks: number; pass: number }): QualificationProgress {
  const retryReason =
    q.outcome === 'failed' ? `${q.passed} of ${q.attempts} known answers matched. This swarm needs ${rule.pass} of ${rule.tasks}. You can try again, or try another model.` : null;
  return { id: q.id, tasks: rule.tasks, pass: rule.pass, attempts: q.attempts, passed: q.passed, outcome: q.outcome, retryReason };
}

/**
 * Leases the next known-answer task of the current qualification round, or repeats the open one.
 * A failed round can be retried: the next lease starts a new round.
 */
export async function leaseQualificationTask(o: { accountId: string; membershipId: string; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const m = await ownedMembership(tx, o.accountId, o.membershipId);
    // Qualification runs real code on the node, so the kill switch stops it too (SPEC 11.6).
    await assertWorkAllowed(tx, { swarmId: m.swarmId }, now);
    if (m.status !== 'qualifying') throw new MembershipError(409, 'not_qualifying', m.status === 'joining' ? 'Approve this swarm’s permissions first.' : 'This membership is not qualifying.');
    const rel = await requireGrant(tx, m);
    const rule = rel.manifest.qualification;

    let [q] = await tx
      .select()
      .from(qualifications)
      .where(and(eq(qualifications.membershipId, m.id), eq(qualifications.releaseId, rel.id), eq(qualifications.outcome, 'in_progress')))
      .limit(1);
    if (!q) [q] = await tx.insert(qualifications).values({ membershipId: m.id, releaseId: rel.id }).returning();

    const attempts = await tx.select().from(qualificationAttempts).where(eq(qualificationAttempts.qualificationId, q!.id));
    const open = attempts.find((a) => a.submittedAt === null);
    const all = await tx.select().from(qualificationTasks).where(eq(qualificationTasks.swarmId, m.swarmId)).orderBy(asc(qualificationTasks.id));
    let attempt = open;
    if (!attempt) {
      const next = all.find((t) => !attempts.some((a) => a.taskId === t.id));
      if (!next && attempts.some((a) => a.checkStatus === 'awaiting'))
        throw new MembershipError(409, 'qualification_checking', 'Your answers are with the swarm’s checker. Qualification finishes when it reports.', { qualification: progress(q!, rule) });
      if (!next) throw new MembershipError(409, 'no_qualification_tasks', 'This swarm has no qualification tasks available right now.');
      [attempt] = await tx
        .insert(qualificationAttempts)
        .values({ qualificationId: q!.id, taskId: next.id, deadlineAt: new Date(now.getTime() + rel.manifest.task.timeout_s * 1000) })
        .returning();
    }
    const task = all.find((t) => t.id === attempt!.taskId)!;
    return { qualification: progress(q!, rule), task: { id: task.id, input: task.inputJson as object }, deadlineAt: attempt!.deadlineAt };
  });
}

/** True when every expected field matches the output exactly. */
export function matchesKnownAnswer(expected: Record<string, unknown>, output: unknown): boolean {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const o = output as Record<string, unknown>;
  return Object.entries(expected).every(([k, v]) => k in o && canonicalJson(o[k]) === canonicalJson(v));
}

/** Scores one known-answer result. Passing activates the membership and rebalances shares. */
export async function submitQualificationResult(o: { accountId: string; membershipId: string; taskId: string; output: unknown; outputHash: string; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const m = await ownedMembership(tx, o.accountId, o.membershipId);
    await assertWorkAllowed(tx, { swarmId: m.swarmId }, now);
    if (m.status !== 'qualifying') throw new MembershipError(409, 'not_qualifying', 'This membership is not qualifying.');
    const rel = await requireGrant(tx, m);
    const rule = rel.manifest.qualification;
    const [q] = await tx
      .select()
      .from(qualifications)
      .where(and(eq(qualifications.membershipId, m.id), eq(qualifications.releaseId, rel.id), eq(qualifications.outcome, 'in_progress')))
      .limit(1);
    if (!q) throw new MembershipError(409, 'no_open_task', 'Lease a qualification task first.');
    const [a] = await tx
      .select()
      .from(qualificationAttempts)
      .where(and(eq(qualificationAttempts.qualificationId, q.id), eq(qualificationAttempts.taskId, o.taskId)))
      .limit(1);
    if (!a) throw new MembershipError(409, 'no_open_task', 'That task was not leased in this qualification.');
    if (a.submittedAt) throw new MembershipError(409, 'already_submitted', 'That task already has a result.');
    const [task] = await tx.select().from(qualificationTasks).where(eq(qualificationTasks.id, o.taskId)).limit(1);
    // A late answer counts as wrong.
    const matches = now <= a.deadlineAt && matchesKnownAnswer(task!.expectedJson as Record<string, unknown>, o.output);
    // A matching answer on a machine-checked task (for example a Lean proof) counts only once the
    // swarm's verifier worker accepts it; until then it is neither right nor wrong (M6).
    const awaiting = matches && task!.machineCheck;
    const correct = awaiting ? null : matches;
    await tx
      .update(qualificationAttempts)
      .set({ submittedAt: now, outputHash: o.outputHash, correct, ...(awaiting ? { outputJson: o.output as object, checkStatus: 'awaiting' as const } : {}) })
      .where(eq(qualificationAttempts.id, a.id));
    const updated = await rescoreQualification(tx, q.id, now);
    return { correct, qualification: progress(updated!, rule) };
  });
}

/**
 * Leave (SPEC 3.2): revoke grants, abandon open leases, give up the share. Credits already earned
 * stay where they are; nothing here touches the ledger.
 */
export async function leaveMembership(o: { accountId: string; membershipId: string; now?: Date }) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const m = await ownedMembership(tx, o.accountId, o.membershipId);
    await tx.update(memberships).set({ status: 'left', leftAt: now, shareBp: 0 }).where(eq(memberships.id, m.id));
    await tx.update(permissionGrants).set({ revokedAt: now }).where(and(eq(permissionGrants.membershipId, m.id), isNull(permissionGrants.revokedAt)));
    const swarmTasks = tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.swarmId, m.swarmId));
    const abandoned = await tx
      .update(leases)
      .set({ status: 'abandoned', abandonedAt: now, requeuedAt: now })
      .where(and(eq(leases.nodeId, m.nodeId), inArray(leases.status, ['leased', 'running']), inArray(leases.taskId, swarmTasks)))
      .returning({ id: leases.id, taskId: leases.taskId });
    // Abandoned work is unpaid and goes straight back to the queue (SPEC 7.3).
    if (abandoned.length) await tx.update(tasks).set({ status: 'queued' }).where(and(inArray(tasks.id, abandoned.map((a) => a.taskId)), eq(tasks.status, 'leased')));
    await rebalance(tx, m.nodeId);
    return { leftAt: now, abandonedLeases: abandoned.length };
  });
}

/** A node's current memberships with their release facts, for store home and the Library. */
export async function nodeMemberships(accountId: string, nodeId: string) {
  const db = await getDb();
  const rows = await db
    .select({ membership: memberships, release: swarmReleases, swarm: swarms, harnessRelease: harnessReleases })
    .from(memberships)
    .innerJoin(swarmReleases, eq(swarmReleases.id, memberships.releaseId))
    .innerJoin(swarms, eq(swarms.id, memberships.swarmId))
    .innerJoin(harnessReleases, eq(harnessReleases.id, swarmReleases.harnessReleaseId))
    .where(and(eq(memberships.accountId, accountId), eq(memberships.nodeId, nodeId), isNull(memberships.leftAt)))
    .orderBy(asc(memberships.joinedAt));
  const out = [];
  for (const r of rows) {
    const q = await db
      .select()
      .from(qualifications)
      .where(and(eq(qualifications.membershipId, r.membership.id), eq(qualifications.releaseId, r.release.id)))
      .orderBy(desc(qualifications.id))
      .limit(1);
    out.push({ ...r, manifest: r.release.manifestJson as ManifestV1, qualification: q[0] ? progress(q[0], (r.release.manifestJson as ManifestV1).qualification) : null });
  }
  return out;
}

/**
 * Release review stub (SPEC 11.6, 13.4 `POST /admin/reviews/{id}`): a reviewer approves or rejects
 * a swarm release that is in review. Approval publishes it. Members whose granted permissions
 * differ stop and must approve again; members with the same permissions move to it.
 */
export async function reviewSwarmRelease(o: {
  reviewerId: string;
  releaseId: string;
  outcome: 'approved' | 'rejected' | 'changes_requested';
  checklist: Record<string, boolean>;
  rationale: string;
  now?: Date;
}) {
  const now = o.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const rel = await release(tx, o.releaseId);
    if (rel.reviewStatus !== 'in_review') throw new MembershipError(409, 'not_in_review', 'This release is not waiting for review.');
    await tx.insert(reviews).values({ targetType: 'swarm_release', targetId: rel.id, reviewerId: o.reviewerId, checklistJson: o.checklist, outcome: o.outcome, rationale: o.rationale });
    const reviewStatus = o.outcome === 'approved' ? ('approved' as const) : o.outcome === 'rejected' ? ('rejected' as const) : ('draft' as const);
    await tx.update(swarmReleases).set({ reviewStatus, publishedAt: o.outcome === 'approved' ? now : null }).where(eq(swarmReleases.id, rel.id));
    let reconsent = 0;
    let moved = 0;
    if (o.outcome === 'approved') {
      const members = await tx
        .select({ membership: memberships, permissionsHash: swarmReleases.permissionsHash })
        .from(memberships)
        .innerJoin(swarmReleases, eq(swarmReleases.id, memberships.releaseId))
        .where(and(eq(memberships.swarmId, rel.swarmId), isNull(memberships.leftAt)));
      for (const { membership: m, permissionsHash } of members) {
        if (permissionsHash === rel.permissionsHash) {
          await tx.update(memberships).set({ releaseId: rel.id }).where(eq(memberships.id, m.id));
          moved++;
        } else if (m.status === 'joining' || m.status === 'qualifying') {
          // Not yet qualified: restart the join on the new release.
          await tx.update(memberships).set({ releaseId: rel.id, status: 'joining' }).where(eq(memberships.id, m.id));
          await tx.update(permissionGrants).set({ revokedAt: now }).where(and(eq(permissionGrants.membershipId, m.id), isNull(permissionGrants.revokedAt)));
          reconsent++;
        } else {
          await tx.update(memberships).set({ status: 'reconsent_required' }).where(eq(memberships.id, m.id));
          reconsent++;
        }
      }
    }
    return { reviewStatus, reconsentRequired: reconsent, moved };
  });
}
