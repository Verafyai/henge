import { canonicalJson, type ManifestV1 } from '@swarm-explorer/schema';
import { sha256Digest } from '@swarm-explorer/schema/node';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from './client';
import {
  grantPermissions,
  leaseQualificationTask,
  leaveMembership,
  matchesKnownAnswer,
  MembershipError,
  nodeMemberships,
  reviewSwarmRelease,
  startJoin,
  submitQualificationResult,
} from './membership';
import { getSwarm } from './queries';
import { accounts, installs, leases, ledgerEntries, memberships, modelArtifacts, models, nodeModels, nodes, permissionGrants, qualifications, qualificationTasks, swarmReleases, tasks } from './schema';
import { settleMachineChecks } from './test-support';
import { runMigrations, seed } from './testing';

let demo = '';
let reviewer = '';

async function newNode(withModel: string | null = 'phi4-14b') {
  const db = await getDb();
  const [inst] = await db
    .insert(installs)
    .values({ accountId: demo, clientId: 'swarm-explorer-desktop', platform: 'darwin', arch: 'arm64', clientVersion: '0.2.0', channel: 'dev', devicePublicKey: 'x' })
    .returning();
  const [node] = await db.insert(nodes).values({ installId: inst!.id, accountId: demo, name: 'Test node', runRulesJson: {} }).returning();
  if (withModel) {
    const [art] = await db
      .select({ id: modelArtifacts.id, hash: modelArtifacts.contentHash })
      .from(modelArtifacts)
      .innerJoin(models, eq(models.id, modelArtifacts.modelId))
      .where(eq(models.slug, withModel));
    await db.insert(nodeModels).values({ nodeId: node!.id, modelArtifactId: art!.id, verifiedHash: art!.hash, fitStatus: 'runs_well' });
  }
  return node!.id;
}

async function expected(slug: string) {
  const db = await getDb();
  const s = await getSwarm(slug);
  return (await db.select().from(qualificationTasks).where(eq(qualificationTasks.swarmId, s!.swarm.id))).map((t) => ({ id: t.id, expected: t.expectedJson as Record<string, unknown> }));
}

/** Joins, approves and answers `right` of the known answers correctly. */
async function qualify(nodeId: string, slug: string, right: number) {
  const s = (await getSwarm(slug))!;
  const { membership } = await startJoin({ accountId: demo, nodeId, slug, manifestHash: s.release.manifestHash });
  await grantPermissions({ accountId: demo, membershipId: membership.id, permissionsHash: s.release.permissionsHash });
  const answers = await expected(slug);
  let last;
  for (let i = 0; i < s.manifest.qualification.tasks; i++) {
    const lease = await leaseQualificationTask({ accountId: demo, membershipId: membership.id });
    const want = answers.find((a) => a.id === lease.task.id)!.expected;
    const output = i < right ? want : Object.fromEntries(Object.entries(want).map(([k, v]) => [k, typeof v === 'boolean' ? !v : `wrong-${String(v)}`]));
    last = await submitQualificationResult({ accountId: demo, membershipId: membership.id, taskId: lease.task.id, output, outputHash: sha256Digest(canonicalJson(output)) });
    if (last.qualification.outcome !== 'in_progress') break;
  }
  // Challenge Vaults answers wait for the coordinator's Lean check; a test worker accepts them.
  if (last!.qualification.outcome === 'in_progress' && (await settleMachineChecks()) > 0) {
    const db = await getDb();
    const [q] = await db.select().from(qualifications).where(eq(qualifications.id, last!.qualification.id));
    last = { ...last!, qualification: { ...last!.qualification, outcome: q!.outcome, passed: q!.passed, attempts: q!.attempts } };
  }
  return { membershipId: membership.id, result: last! };
}

beforeAll(async () => {
  await runMigrations();
  await seed();
  const db = await getDb();
  const rows = await db.select({ id: accounts.id, handle: accounts.handle }).from(accounts);
  demo = rows.find((r) => r.handle === 'demo')!.id;
  reviewer = rows.find((r) => r.handle === 'reviewer')!.id;
}, 60_000);

describe('join and permissions (SPEC 3.2, 11.4, 13.2)', () => {
  it('refuses a node with no model the swarm policy accepts, and a stale release', async () => {
    const bare = await newNode(null);
    const s = (await getSwarm('prompt-guard-red-team'))!;
    await expect(startJoin({ accountId: demo, nodeId: bare, slug: s.swarm.slug, manifestHash: s.release.manifestHash })).rejects.toMatchObject({ code: 'policy_mismatch' });
    const node = await newNode();
    await expect(startJoin({ accountId: demo, nodeId: node, slug: s.swarm.slug, manifestHash: `sha256-${'0'.repeat(64)}` })).rejects.toMatchObject({ code: 'release_changed' });
    // The juror class is not the coder model's class.
    const j = (await getSwarm('verafy-dao-juries'))!;
    await expect(startJoin({ accountId: demo, nodeId: node, slug: j.swarm.slug, manifestHash: j.release.manifestHash })).rejects.toMatchObject({ code: 'policy_mismatch' });
  });

  it('only the exact permissions hash is accepted, and qualification needs the grant', async () => {
    const node = await newNode();
    const s = (await getSwarm('prompt-guard-red-team'))!;
    const { membership } = await startJoin({ accountId: demo, nodeId: node, slug: s.swarm.slug, manifestHash: s.release.manifestHash });
    expect(membership).toMatchObject({ status: 'joining', shareBp: 0 });
    await expect(leaseQualificationTask({ accountId: demo, membershipId: membership.id })).rejects.toMatchObject({ code: 'not_qualifying' });
    await expect(grantPermissions({ accountId: demo, membershipId: membership.id, permissionsHash: `sha256-${'1'.repeat(64)}` })).rejects.toMatchObject({ code: 'permissions_changed' });
    // Another account cannot touch it.
    await expect(grantPermissions({ accountId: reviewer, membershipId: membership.id, permissionsHash: s.release.permissionsHash })).rejects.toMatchObject({ status: 404 });
    const g = await grantPermissions({ accountId: demo, membershipId: membership.id, permissionsHash: s.release.permissionsHash });
    expect(g.status).toBe('qualifying');
    expect(g.grant.grantedJson).toEqual(s.manifest.permissions);
    // Joining again resumes the same membership instead of creating a second one.
    const again = await startJoin({ accountId: demo, nodeId: node, slug: s.swarm.slug, manifestHash: s.release.manifestHash });
    expect(again).toMatchObject({ resumed: true, membership: { id: membership.id } });
  });
});

describe('qualification (SPEC 3.2, 4.2)', () => {
  it('passes at the manifest pass rule, activates, and gives equal shares that sum to 100%', async () => {
    const node = await newNode();
    const a = await qualify(node, 'prompt-guard-red-team', 2);
    expect(a.result.qualification).toMatchObject({ outcome: 'passed', passed: 2, attempts: 2, tasks: 3, pass: 2 });
    const b = await qualify(node, 'challenge-vaults', 3);
    expect(b.result.qualification.outcome).toBe('passed');
    const mine = await nodeMemberships(demo, node);
    expect(mine.map((m) => m.membership.status)).toEqual(['active', 'active']);
    expect(mine.map((m) => m.membership.shareBp)).toEqual([5000, 5000]);
    // Qualification is not credited work: no ledger entries were written.
    const db = await getDb();
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(ledgerEntries))[0]!.n).toBe(0);
  });

  it('fails when the pass rule can no longer be met, explains why, and allows a retry', async () => {
    const node = await newNode();
    const f = await qualify(node, 'prompt-guard-red-team', 0);
    expect(f.result.qualification).toMatchObject({ outcome: 'failed', attempts: 2, passed: 0 });
    expect(f.result.qualification.retryReason).toBe('0 of 2 known answers matched. This swarm needs 2 of 3. You can try again, or try another model.');
    const [m] = await nodeMemberships(demo, node);
    expect(m!.membership).toMatchObject({ status: 'qualifying', shareBp: 0 });
    // A new lease starts a new round.
    const retry = await leaseQualificationTask({ accountId: demo, membershipId: f.membershipId });
    expect(retry.qualification).toMatchObject({ outcome: 'in_progress', attempts: 0 });
    expect(retry.qualification.id).not.toBe(f.result.qualification.id);
  });

  it('repeats an open lease, refuses a double submit, and counts a late answer as wrong', async () => {
    const node = await newNode();
    const s = (await getSwarm('prompt-guard-red-team'))!;
    const { membership } = await startJoin({ accountId: demo, nodeId: node, slug: s.swarm.slug, manifestHash: s.release.manifestHash });
    await grantPermissions({ accountId: demo, membershipId: membership.id, permissionsHash: s.release.permissionsHash });
    const l1 = await leaseQualificationTask({ accountId: demo, membershipId: membership.id });
    const l2 = await leaseQualificationTask({ accountId: demo, membershipId: membership.id });
    expect(l2.task.id).toBe(l1.task.id);
    const late = new Date(l1.deadlineAt.getTime() + 1);
    const r = await submitQualificationResult({ accountId: demo, membershipId: membership.id, taskId: l1.task.id, output: { reproduced: false, attack: null }, outputHash: 'h', now: late });
    expect(r.correct).toBe(false);
    await expect(submitQualificationResult({ accountId: demo, membershipId: membership.id, taskId: l1.task.id, output: {}, outputHash: 'h' })).rejects.toMatchObject({ code: 'already_submitted' });
  });

  it('compares known answers field by field', () => {
    expect(matchesKnownAnswer({ verdict: 'accept' }, { verdict: 'accept', rationale: 'x' })).toBe(true);
    expect(matchesKnownAnswer({ verdict: 'accept' }, { verdict: 'reject' })).toBe(false);
    expect(matchesKnownAnswer({ reproduced: false }, {})).toBe(false);
    expect(matchesKnownAnswer({ reproduced: false }, null)).toBe(false);
  });
});

describe('leave (SPEC 3.2)', () => {
  it('revokes grants, abandons open leases at once and rebalances the remaining shares', async () => {
    const node = await newNode();
    const a = await qualify(node, 'prompt-guard-red-team', 3);
    const b = await qualify(node, 'challenge-vaults', 3);
    const db = await getDb();
    const s = (await getSwarm('challenge-vaults'))!;
    const [t] = await db.insert(tasks).values({ swarmId: s.swarm.id, releaseId: s.release.id, coordinatorTaskId: `t-${node}`, inputRef: 'r', inputHash: 'h', modelRequirementJson: {} }).returning();
    await db.insert(leases).values({ taskId: t!.id, nodeId: node, accountId: demo, deadlineAt: new Date(Date.now() + 60_000), idempotencyKey: `k-${node}` });

    const r = await leaveMembership({ accountId: demo, membershipId: b.membershipId });
    expect(r.abandonedLeases).toBe(1);
    const [lease] = await db.select().from(leases).where(eq(leases.nodeId, node));
    expect(lease).toMatchObject({ status: 'abandoned' });
    expect(lease!.abandonedAt).not.toBeNull();
    expect(await db.select().from(permissionGrants).where(and(eq(permissionGrants.membershipId, b.membershipId), sql`${permissionGrants.revokedAt} is null`))).toEqual([]);
    const left = await nodeMemberships(demo, node);
    expect(left.map((m) => [m.membership.id, m.membership.shareBp])).toEqual([[a.membershipId, 10_000]]);
    await expect(leaveMembership({ accountId: demo, membershipId: b.membershipId })).rejects.toMatchObject({ code: 'membership_left' });
    // Joining again after leaving is a fresh membership.
    const again = await startJoin({ accountId: demo, nodeId: node, slug: 'challenge-vaults', manifestHash: s.release.manifestHash });
    expect(again.resumed).toBe(false);
  });
});

describe('release review and reconsent (SPEC 4.2, 11.4, 11.6)', () => {
  async function submitRelease(slug: string, change: (m: ManifestV1) => ManifestV1) {
    const db = await getDb();
    const s = (await getSwarm(slug))!;
    const manifest = change(structuredClone(s.manifest));
    const [r] = await db
      .insert(swarmReleases)
      .values({
        swarmId: s.swarm.id,
        manifestVersion: 1,
        manifestJson: manifest,
        manifestHash: sha256Digest(canonicalJson(manifest)),
        harnessReleaseId: s.release.harnessReleaseId,
        coordinatorConfig: manifest.coordinator,
        signature: s.release.signature as object,
        permissionsHash: sha256Digest(canonicalJson(manifest.permissions)),
      })
      .returning();
    return r!;
  }

  it('a release that adds a permission stops active members until they approve it again', async () => {
    const node = await newNode();
    const a = await qualify(node, 'challenge-vaults', 3);
    const r = await submitRelease('challenge-vaults', (m) => ({ ...m, permissions: { ...m.permissions, network: ['lean-lang.org'] } }));
    // Not listed until reviewed.
    expect((await getSwarm('challenge-vaults'))!.release.id).not.toBe(r.id);
    const out = await reviewSwarmRelease({ reviewerId: reviewer, releaseId: r.id, outcome: 'approved', checklist: { permissions_minimal: true }, rationale: 'Example review.' });
    expect(out.reviewStatus).toBe('approved');
    expect((await getSwarm('challenge-vaults'))!.release.id).toBe(r.id);
    const [m] = await nodeMemberships(demo, node);
    // Work stops, the share is kept, and the old grant no longer covers the new release.
    expect(m!.membership).toMatchObject({ status: 'reconsent_required', shareBp: 10_000 });
    await expect(grantPermissions({ accountId: demo, membershipId: a.membershipId, permissionsHash: m!.release.permissionsHash })).rejects.toMatchObject({ code: 'permissions_changed' });
    const g = await grantPermissions({ accountId: demo, membershipId: a.membershipId, permissionsHash: r.permissionsHash });
    expect(g).toMatchObject({ status: 'active', releaseId: r.id });
    await expect(reviewSwarmRelease({ reviewerId: reviewer, releaseId: r.id, outcome: 'approved', checklist: {}, rationale: 'again' })).rejects.toMatchObject({ code: 'not_in_review' });
  });

  it('a release with the same permissions moves members forward without asking', async () => {
    const node = await newNode();
    await qualify(node, 'prompt-guard-red-team', 3);
    const r = await submitRelease('prompt-guard-red-team', (m) => ({ ...m, summary: `${m.summary}.` }));
    const out = await reviewSwarmRelease({ reviewerId: reviewer, releaseId: r.id, outcome: 'approved', checklist: {}, rationale: 'Copy change.' });
    expect(out.moved).toBeGreaterThanOrEqual(1);
    const [m] = await nodeMemberships(demo, node);
    expect(m!.membership).toMatchObject({ status: 'active', releaseId: r.id });
  });

  it('a rejected release is never listed', async () => {
    const r = await submitRelease('verafy-dao-juries', (m) => ({ ...m, summary: 'Rejected change' }));
    await reviewSwarmRelease({ reviewerId: reviewer, releaseId: r.id, outcome: 'rejected', checklist: {}, rationale: 'No.' });
    expect((await getSwarm('verafy-dao-juries'))!.manifest.summary).not.toBe('Rejected change');
    const db = await getDb();
    expect((await db.select().from(memberships).where(eq(memberships.releaseId, r.id))).length).toBe(0);
  });

  it('errors carry a status and a code', () => {
    const e = new MembershipError(409, 'x', 'msg');
    expect([e.status, e.code, e.message]).toEqual([409, 'x', 'msg']);
  });
});
