import { leaseTransitions } from '@swarm-explorer/core';
import { canonicalJson } from '@swarm-explorer/schema';
import { sha256Digest } from '@swarm-explorer/schema/node';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from './client';
import {
  abandonLease,
  leaseInput,
  getLease,
  renewLease,
  requestLease,
  setShares,
  startLease,
  submitResult,
  uploadTasks,
  type RunRecordRow,
} from './coordinator';
import { grantPermissions, leaseQualificationTask, leaveMembership, nodeMemberships, startJoin, submitQualificationResult } from './membership';
import { getSwarm } from './queries';
import { accounts, deadlineMisses, installs, leaseRules, leases, ledgerEntries, modelArtifacts, models, nodeModels, nodes, qualificationTasks, results, tasks } from './schema';
import { settleMachineChecks } from './test-support';
import { runMigrations, seed } from './testing';

let demo = '';
let team = '';
let coderHash = '';
const SLUG = 'prompt-guard-red-team';

async function newNode(slugs: string[] = ['phi4-14b']) {
  const db = await getDb();
  const [inst] = await db
    .insert(installs)
    .values({ accountId: demo, clientId: 'swarm-explorer-desktop', platform: 'darwin', arch: 'arm64', clientVersion: '0.2.0', channel: 'dev', devicePublicKey: 'x' })
    .returning();
  const [node] = await db.insert(nodes).values({ installId: inst!.id, accountId: demo, name: 'Test node', runRulesJson: {} }).returning();
  for (const slug of slugs) {
    const [art] = await db.select({ id: modelArtifacts.id, hash: modelArtifacts.contentHash }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, slug));
    await db.insert(nodeModels).values({ nodeId: node!.id, modelArtifactId: art!.id, verifiedHash: art!.hash, fitStatus: 'runs_well' });
  }
  return node!.id;
}

async function qualify(nodeId: string, slug = SLUG) {
  const db = await getDb();
  const s = (await getSwarm(slug))!;
  const { membership } = await startJoin({ accountId: demo, nodeId, slug, manifestHash: s.release.manifestHash });
  await grantPermissions({ accountId: demo, membershipId: membership.id, permissionsHash: s.release.permissionsHash });
  const known = await db.select().from(qualificationTasks).where(eq(qualificationTasks.swarmId, s.swarm.id));
  for (let i = 0; i < s.manifest.qualification.pass; i++) {
    const l = await leaseQualificationTask({ accountId: demo, membershipId: membership.id });
    const output = known.find((k) => k.id === l.task.id)!.expectedJson as Record<string, unknown>;
    await submitQualificationResult({ accountId: demo, membershipId: membership.id, taskId: l.task.id, output, outputHash: sha256Digest(canonicalJson(output)) });
  }
  // Challenge Vaults answers wait for the Lean machine check; a test worker accepts them.
  await settleMachineChecks();
  return membership.id;
}

const lease = (nodeId: string, o: { now?: Date; slug?: string; model?: string } = {}) =>
  requestLease({ accountId: demo, nodeId, slug: o.slug ?? SLUG, modelArtifactHash: o.model ?? coderHash, idempotencyKey: `k-${Math.random()}`, ...(o.now ? { now: o.now } : {}) });

async function pins() {
  const s = (await getSwarm(SLUG))!;
  return { harnessHash: s.manifest.harness.hash, permissionsHash: s.release.permissionsHash, modelArtifactHash: coderHash };
}

function run(output: object): RunRecordRow {
  return { modelIdClaim: 'phi4-14b', modelArtifactHash: coderHash, provider: null, harnessHash: 'h', tokensIn: 1, tokensOut: 2, elapsedMs: 3, costUsdMicrosReported: null, signature: `sig-${Math.random()}`, record: { output_sha256: sha256Digest(canonicalJson(output)) } };
}
const out = (n: number) => ({ reproduced: false, attack: null, n });

async function addTasks(n: number, prefix: string) {
  await uploadTasks({ accountId: team, slug: SLUG, tasks: Array.from({ length: n }, (_, i) => ({ coordinator_task_id: `${prefix}-${i}`, input: { policy: 'p', guarded_prompt: `${prefix} ${i}` } })) });
}

beforeAll(async () => {
  await runMigrations();
  await seed();
  const db = await getDb();
  const rows = await db.select({ id: accounts.id, handle: accounts.handle }).from(accounts);
  demo = rows.find((r) => r.handle === 'demo')!.id;
  team = rows.find((r) => r.handle === 'verafy-team')!.id;
  const [art] = await db.select({ hash: modelArtifacts.contentHash }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, 'phi4-14b'));
  coderHash = art!.hash;
}, 60_000);

describe('task upload (hosted coordinator)', () => {
  it('only the publisher uploads; idempotent by coordinator task id; urgent only where allowed', async () => {
    await expect(uploadTasks({ accountId: demo, slug: SLUG, tasks: [{ coordinator_task_id: 'x', input: {} }] })).rejects.toMatchObject({ status: 403 });
    expect(await uploadTasks({ accountId: team, slug: SLUG, tasks: [{ coordinator_task_id: 'up-1', input: { a: 1 } }] })).toEqual({ accepted: 1, duplicates: 0 });
    expect(await uploadTasks({ accountId: team, slug: SLUG, tasks: [{ coordinator_task_id: 'up-1', input: { a: 1 } }] })).toEqual({ accepted: 0, duplicates: 1 });
    await expect(uploadTasks({ accountId: team, slug: SLUG, tasks: [{ coordinator_task_id: 'up-2', input: {}, urgent: true }] })).rejects.toMatchObject({ code: 'urgent_not_allowed' });
    const db = await getDb();
    const [t] = await db.select().from(tasks).where(eq(tasks.coordinatorTaskId, 'up-1'));
    expect(t).toMatchObject({ status: 'queued', rewardCredits: null, inputHash: sha256Digest(canonicalJson({ a: 1 })) });
  });
});

describe('leases (SPEC 7.3, 13.3)', () => {
  it('only an active, qualified member with an accepted model leases, one at a time', async () => {
    const node = await newNode();
    await expect(lease(node)).rejects.toMatchObject({ code: 'not_a_member' });
    const s = (await getSwarm(SLUG))!;
    const { membership } = await startJoin({ accountId: demo, nodeId: node, slug: SLUG, manifestHash: s.release.manifestHash });
    await expect(lease(node)).rejects.toMatchObject({ code: 'not_eligible', details: { status: 'joining' } });
    await grantPermissions({ accountId: demo, membershipId: membership.id, permissionsHash: s.release.permissionsHash });
    await expect(lease(node)).rejects.toMatchObject({ code: 'not_eligible', details: { status: 'qualifying' } });

    const ready = await newNode();
    await qualify(ready);
    await expect(lease(ready, { model: `sha256-${'9'.repeat(64)}` })).rejects.toMatchObject({ code: 'policy_mismatch' });
    const first = await lease(ready);
    expect(first.reason).toBeNull();
    expect(first.grant).toMatchObject({ swarm: SLUG, reward: { funded: false, credits: null }, lease: { status: 'leased', urgent: false } });
    expect(first.grant!.lease.deadlineAt.getTime() - first.grant!.lease.leasedAt.getTime()).toBe(s.manifest.task.timeout_s * 1000);
    // Local GPU concurrency defaults to one lease per node.
    await expect(lease(ready)).rejects.toMatchObject({ code: 'concurrency_limit' });
    await abandonLease({ accountId: demo, leaseId: first.grant!.lease.id, reason: 'test' });
  });

  it('funded swarms lease nothing until publisher funding exists (volunteer only, M9)', async () => {
    const node = await newNode(['mistral-small-24b']);
    await qualify(node, 'verafy-dao-juries');
    const db = await getDb();
    const j = (await getSwarm('verafy-dao-juries'))!;
    await db.insert(tasks).values({ swarmId: j.swarm.id, releaseId: j.release.id, coordinatorTaskId: 'paid-1', inputRef: 'r', inputHash: 'h', inputJson: {}, modelRequirementJson: {}, rewardCredits: 12 });
    const [art] = await db.select({ hash: modelArtifacts.contentHash }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, 'mistral-small-24b'));
    expect(await lease(node, { slug: 'verafy-dao-juries', model: art!.hash })).toEqual({ grant: null, reason: 'pool_empty' });
    expect(await db.select().from(ledgerEntries)).toEqual([]);
  });

  it('start checks pins, then hands out the input; submit is idempotent by lease and result hash', async () => {
    await addTasks(2, 'submit');
    const node = await newNode();
    await qualify(node);
    const g = (await lease(node)).grant!;
    const id = g.lease.id;
    await expect(leaseInput({ accountId: demo, leaseId: id })).rejects.toMatchObject({ code: 'lease_not_running' });
    await expect(submitResult({ accountId: demo, leaseId: id, output: out(1), outputHash: sha256Digest(canonicalJson(out(1))), schemaValid: true, run: run(out(1)) })).rejects.toMatchObject({ code: 'lease_not_running' });
    const p = await pins();
    await expect(startLease({ accountId: demo, leaseId: id, pins: { ...p, permissionsHash: `sha256-${'0'.repeat(64)}` } })).rejects.toMatchObject({ code: 'pin_mismatch' });
    const started = await startLease({ accountId: demo, leaseId: id, pins: p });
    expect(started.lease.status).toBe('running');
    expect(sha256Digest(canonicalJson(started.input))).toBe(started.inputHash);
    expect((await leaseInput({ accountId: demo, leaseId: id })).input).toEqual(started.input);

    const hash = sha256Digest(canonicalJson(out(1)));
    const a = await submitResult({ accountId: demo, leaseId: id, output: out(1), outputHash: hash, schemaValid: true, run: run(out(1)) });
    expect(a).toMatchObject({ duplicate: false, lease: { status: 'submitted' }, result: { disposition: 'on_time', schemaValid: true } });
    const b = await submitResult({ accountId: demo, leaseId: id, output: out(1), outputHash: hash, schemaValid: true, run: run(out(1)) });
    expect(b).toMatchObject({ duplicate: true, result: { id: a.result.id } });
    await expect(submitResult({ accountId: demo, leaseId: id, output: out(2), outputHash: sha256Digest(canonicalJson(out(2))), schemaValid: true, run: run(out(2)) })).rejects.toMatchObject({ code: 'already_submitted' });
    const db = await getDb();
    expect(await db.select().from(results).where(eq(results.leaseId, id))).toHaveLength(1);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, g.taskId));
    expect(t!.status).toBe('completed');
    // Submitted is where M5 stops: verification moves it on (M6). Nothing is credited.
    expect(leaseTransitions.submitted).toEqual(['verifying', 'rejected']);
    expect((await getLease({ accountId: demo, leaseId: id })).grant.lease.status).toBe('submitted');
    expect(await db.select().from(ledgerEntries)).toEqual([]);
    await expect(abandonLease({ accountId: demo, leaseId: id, reason: 'late pause' })).rejects.toMatchObject({ code: 'already_submitted' });
  });

  it('abandon is unpaid and requeues at once; a result after abandoning is recorded, not paid', async () => {
    await addTasks(1, 'abandon');
    const node = await newNode();
    await qualify(node);
    const g = (await lease(node)).grant!;
    await startLease({ accountId: demo, leaseId: g.lease.id, pins: await pins() });
    const a = await abandonLease({ accountId: demo, leaseId: g.lease.id, reason: 'pause' });
    expect(a).toMatchObject({ status: 'abandoned' });
    expect(a.requeuedAt).not.toBeNull();
    expect((await abandonLease({ accountId: demo, leaseId: g.lease.id, reason: 'pause' })).status).toBe('abandoned');
    const db = await getDb();
    expect((await db.select().from(tasks).where(eq(tasks.id, g.taskId)))[0]!.status).toBe('queued');
    const late = await submitResult({ accountId: demo, leaseId: g.lease.id, output: out(3), outputHash: sha256Digest(canonicalJson(out(3))), schemaValid: true, run: run(out(3)) });
    expect(late).toMatchObject({ lease: { status: 'abandoned' }, result: { disposition: 'after_abandon' } });
    // The same task is leased again, first in line.
    const again = (await lease(node)).grant!;
    expect(again.taskId).toBe(g.taskId);
    await abandonLease({ accountId: demo, leaseId: again.lease.id, reason: 'test' });
  });

  it('a missed deadline expires the lease, requeues the task and counts the miss per rule version; a late result is not paid', async () => {
    await addTasks(1, 'expire');
    const node = await newNode();
    await qualify(node);
    const g = (await lease(node)).grant!;
    await startLease({ accountId: demo, leaseId: g.lease.id, pins: await pins() });
    const after = new Date(g.lease.deadlineAt.getTime() + 1000);
    // The next lease call sweeps expired leases first, so the node gets work again.
    const next = await lease(node, { now: after });
    expect(next.grant).not.toBeNull();
    const db = await getDb();
    const [old] = await db.select().from(leases).where(eq(leases.id, g.lease.id));
    expect(old).toMatchObject({ status: 'expired' });
    expect(old!.requeuedAt).not.toBeNull();
    const s = (await getSwarm(SLUG))!;
    const [miss] = await db.select().from(deadlineMisses).where(and(eq(deadlineMisses.nodeId, node), eq(deadlineMisses.swarmId, s.swarm.id)));
    expect(miss).toMatchObject({ ruleVersion: 1, misses: 1 });
    // No threshold is approved, so the rule stores none and nothing lowers reputation.
    const [rule] = await db.select().from(leaseRules).where(eq(leaseRules.swarmId, s.swarm.id));
    expect(rule).toMatchObject({ version: 1, repeatedMissThreshold: null, maxRenewals: null, status: 'proposal' });
    const late = await submitResult({ accountId: demo, leaseId: g.lease.id, output: out(4), outputHash: sha256Digest(canonicalJson(out(4))), schemaValid: true, run: run(out(4)), now: after });
    expect(late).toMatchObject({ lease: { status: 'expired' }, result: { disposition: 'late' } });
    await abandonLease({ accountId: demo, leaseId: next.grant!.lease.id, reason: 'test', now: after });
  });

  it('renewal happens only before the deadline and only when the lease rule grants it', async () => {
    await addTasks(1, 'renew');
    const node = await newNode();
    await qualify(node);
    const g = (await lease(node)).grant!;
    await expect(renewLease({ accountId: demo, leaseId: g.lease.id })).rejects.toMatchObject({ code: 'renewal_refused' });
    const db = await getDb();
    const s = (await getSwarm(SLUG))!;
    await db.insert(leaseRules).values({ swarmId: s.swarm.id, version: 2, maxRenewals: 1, notes: 'test only' });
    const soon = new Date(g.lease.deadlineAt.getTime() - 1000);
    const r = await renewLease({ accountId: demo, leaseId: g.lease.id, now: soon });
    expect(r.deadlineAt.getTime()).toBe(soon.getTime() + s.manifest.task.timeout_s * 1000);
    await expect(renewLease({ accountId: demo, leaseId: g.lease.id, now: soon })).rejects.toMatchObject({ code: 'renewal_refused' });
    await expect(renewLease({ accountId: demo, leaseId: g.lease.id, now: new Date(r.deadlineAt.getTime() + 1) })).rejects.toMatchObject({ code: 'lease_expired' });
    await db.delete(leaseRules).where(and(eq(leaseRules.swarmId, s.swarm.id), eq(leaseRules.version, 2)));
  });

  it('urgent tasks are leased first', async () => {
    const node = await newNode();
    await qualify(node);
    const db = await getDb();
    const s = (await getSwarm(SLUG))!;
    const [u] = await db.insert(tasks).values({ swarmId: s.swarm.id, releaseId: s.release.id, coordinatorTaskId: 'urgent-1', inputRef: 'r', inputHash: sha256Digest(canonicalJson({})), inputJson: {}, modelRequirementJson: {}, urgent: true }).returning();
    const g = (await lease(node)).grant!;
    expect(g).toMatchObject({ taskId: u!.id, lease: { urgent: true } });
    await abandonLease({ accountId: demo, leaseId: g.lease.id, reason: 'test' });
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, u!.id));
  });

  it('leave abandons open leases and requeues their tasks', async () => {
    await addTasks(1, 'leave');
    const node = await newNode();
    const membershipId = await qualify(node);
    const g = (await lease(node)).grant!;
    expect((await leaveMembership({ accountId: demo, membershipId })).abandonedLeases).toBe(1);
    const db = await getDb();
    expect((await db.select().from(tasks).where(eq(tasks.id, g.taskId)))[0]!.status).toBe('queued');
  });
});

describe('timeshare (SPEC 7.1)', () => {
  it('sets shares atomically, asks before rebalancing customized shares, and spreads a left share in proportion', async () => {
    const node = await newNode(['phi4-14b']);
    const pg = await qualify(node, SLUG);
    const cv = await qualify(node, 'challenge-vaults');
    const shares = async () => (await nodeMemberships(demo, node)).map((m) => [m.membership.id, m.membership.shareBp]);
    expect(await shares()).toEqual([[pg, 5000], [cv, 5000]]);
    await expect(setShares({ accountId: demo, nodeId: node, shares: [{ membershipId: pg, shareBp: 6000 }, { membershipId: cv, shareBp: 3000 }] })).rejects.toMatchObject({ code: 'shares_invalid' });
    await expect(setShares({ accountId: demo, nodeId: node, shares: [{ membershipId: pg, shareBp: 10_000 }] })).rejects.toMatchObject({ code: 'shares_invalid' });
    expect(await setShares({ accountId: demo, nodeId: node, shares: [{ membershipId: pg, shareBp: 7000 }, { membershipId: cv, shareBp: 3000 }] })).toMatchObject({ customized: true });
    const db = await getDb();
    expect((await db.select().from(nodes).where(eq(nodes.id, node)))[0]!.sharesCustomized).toBe(true);

    // A third swarm qualifies: customized shares are kept and the newcomer starts at 0 until asked.
    await db.insert(nodeModels).values({
      nodeId: node,
      modelArtifactId: (await db.select({ id: modelArtifacts.id }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, 'mistral-small-24b')))[0]!.id,
      verifiedHash: 'v',
      fitStatus: 'runs_well',
    });
    const jr = await qualify(node, 'verafy-dao-juries');
    expect(await shares()).toEqual([[pg, 7000], [cv, 3000], [jr, 0]]);
    expect((await nodeMemberships(demo, node)).reduce((a, m) => a + m.membership.shareBp, 0)).toBe(10_000);

    // Leaving spreads the share it held in proportion; it is not equalized.
    await leaveMembership({ accountId: demo, membershipId: cv });
    expect(await shares()).toEqual([[pg, 10_000], [jr, 0]]);
    // Choosing equal shares clears the customized flag.
    expect(await setShares({ accountId: demo, nodeId: node, shares: [{ membershipId: pg, shareBp: 5000 }, { membershipId: jr, shareBp: 5000 }] })).toMatchObject({ customized: false });
  });
});
