import { createHash, randomBytes } from 'node:crypto';
import {
  joinStartedSchema,
  membershipLeftSchema,
  permissionGrantedSchema,
  qualificationLeaseSchema,
  qualificationScoredSchema,
  registerInstallResponseSchema,
  releaseReviewedSchema,
  storeHomeSchema,
} from '@swarm-explorer/api-client';
import { getDb, getSwarm, modelArtifacts, models, nodeModels, qualificationTasks, swarmReleases } from '@swarm-explorer/db';
import { runMigrations, seed } from '@swarm-explorer/db/testing';
import { canonicalJson } from '@swarm-explorer/schema';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { signIn, signed, type Device } from '@/lib/test-device';
import { POST as review } from './admin/reviews/[id]/route';
import { POST as registerInstall } from './installs/route';
import { POST as grant } from './memberships/[id]/permission-grants/route';
import { POST as qualLease } from './memberships/[id]/qualification/lease/route';
import { POST as qualResult } from './memberships/[id]/qualification/results/route';
import { DELETE as leave } from './memberships/[id]/route';
import { GET as storeHome } from './store/home/route';
import { POST as join } from './swarms/[slug]/memberships/route';

const digest = (v: unknown) => `sha256-${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;
const id = (v: string) => ({ params: Promise.resolve({ id: v }) });

let demo: Device;
let reviewer: Device;
let nodeId: string;

async function call(fn: (req: Request, ctx: never) => Promise<Response>, d: Device, method: string, path: string, body: unknown, ctx: unknown) {
  const res = await fn(signed(d, method, path, body === undefined ? '' : JSON.stringify(body)), ctx as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  await runMigrations();
  await seed();
  demo = await signIn('demo');
  reviewer = await signIn('reviewer');
  const r = registerInstallResponseSchema.parse(await (await registerInstall(signed(demo, 'POST', '/v1/installs', JSON.stringify({ app_version: '0.2.0', channel: 'dev', platform: 'darwin', arch: 'arm64' })), undefined as never)).json());
  nodeId = r.node_id;
  const db = await getDb();
  const [art] = await db.select({ id: modelArtifacts.id, hash: modelArtifacts.contentHash }).from(modelArtifacts).innerJoin(models, eq(models.id, modelArtifacts.modelId)).where(eq(models.slug, 'phi4-14b'));
  await db.insert(nodeModels).values({ nodeId, modelArtifactId: art!.id, verifiedHash: art!.hash, fitStatus: 'runs_well' });
});

describe('join, qualify and leave over the signed API (SPEC 13.2)', () => {
  let membershipId = '';

  it('starts a join and returns exactly the permissions to approve', async () => {
    const s = (await getSwarm('prompt-guard-red-team'))!;
    const path = '/v1/swarms/prompt-guard-red-team/memberships';
    const r = await call(join, demo, 'POST', path, { node_id: nodeId, manifest_hash: s.release.manifestHash }, { params: Promise.resolve({ slug: 'prompt-guard-red-team' }) });
    expect(r.status).toBe(201);
    const j = joinStartedSchema.parse(r.body);
    expect(j.permissions_hash).toBe(s.release.permissionsHash);
    expect(j.permissions).toEqual({ network: [], scratchDiskGb: 0.5, gpuCompute: false, apiSpendDailyUsd: null });
    expect(j.membership).toMatchObject({ status: 'joining', share_bp: 0 });
    expect(j.models.map((m) => m.license_id)).toEqual(['mit']);
    membershipId = j.membership.id;

    // Another account's install cannot see or act on it.
    const theirs = await call(grant, reviewer, 'POST', `/v1/memberships/${membershipId}/permission-grants`, { permissions_hash: j.permissions_hash }, id(membershipId));
    expect(theirs.status).toBe(404);
    // A stale manifest hash is refused with the current one.
    const stale = await call(join, demo, 'POST', path, { node_id: nodeId, manifest_hash: `sha256-${'0'.repeat(64)}` }, { params: Promise.resolve({ slug: 'prompt-guard-red-team' }) });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'release_changed', details: { manifest_hash: s.release.manifestHash } } } });
  });

  it('qualifies with known answers that never leave the server', async () => {
    const s = (await getSwarm('prompt-guard-red-team'))!;
    const g = await call(grant, demo, 'POST', `/v1/memberships/${membershipId}/permission-grants`, { permissions_hash: s.release.permissionsHash }, id(membershipId));
    expect(permissionGrantedSchema.parse(g.body).membership.status).toBe('qualifying');

    const db = await getDb();
    const answers = await db.select().from(qualificationTasks).where(eq(qualificationTasks.swarmId, s.swarm.id));
    let scored;
    for (let i = 0; i < 2; i++) {
      const l = await call(qualLease, demo, 'POST', `/v1/memberships/${membershipId}/qualification/lease`, undefined, id(membershipId));
      const lease = qualificationLeaseSchema.parse(l.body);
      expect(JSON.stringify(l.body)).not.toContain('expected');
      const output = answers.find((a) => a.id === lease.task.id)!.expectedJson as Record<string, unknown>;
      const body = {
        task_id: lease.task.id,
        output: { ...output, attack: null },
        output_sha256: digest({ ...output, attack: null }),
        run: { model_artifact_hash: `sha256-${'a'.repeat(64)}`, harness_hash: s.manifest.harness.hash, screen: { verdict: 'allow', reasons: [], screener: 'heuristic-v1' } },
      };
      const bad = await call(qualResult, demo, 'POST', `/v1/memberships/${membershipId}/qualification/results`, { ...body, output_sha256: `sha256-${'b'.repeat(64)}` }, id(membershipId));
      expect(bad.body).toMatchObject({ error: { code: 'output_hash_mismatch' } });
      scored = qualificationScoredSchema.parse((await call(qualResult, demo, 'POST', `/v1/memberships/${membershipId}/qualification/results`, body, id(membershipId))).body);
      expect(scored.correct).toBe(true);
    }
    expect(scored!.qualification.outcome).toBe('passed');
    expect(scored!.membership).toMatchObject({ status: 'active', share_bp: 10_000 });

    const home = storeHomeSchema.parse((await call(storeHome, demo, 'GET', `/v1/store/home?node_id=${nodeId}`, undefined, {})).body);
    expect(home.joined.map((j) => [j.swarm, j.status, j.share_bp])).toEqual([['prompt-guard-red-team', 'active', 10_000]]);
    expect(home.node).toMatchObject({ qualified_swarms: 1, share_total_bp: 10_000 });
    expect(home.featured.length).toBeLessThanOrEqual(3);
  });

  it('only reviewers can review; a permission change asks for consent again', async () => {
    const db = await getDb();
    const s = (await getSwarm('prompt-guard-red-team'))!;
    const manifest = { ...s.manifest, permissions: { ...s.manifest.permissions, scratch_disk_gb: 1 } };
    const [rel] = await db
      .insert(swarmReleases)
      .values({
        swarmId: s.swarm.id,
        manifestVersion: 1,
        manifestJson: manifest,
        manifestHash: digest(manifest),
        harnessReleaseId: s.release.harnessReleaseId,
        coordinatorConfig: manifest.coordinator,
        signature: s.release.signature as object,
        permissionsHash: digest(manifest.permissions),
      })
      .returning();
    const req = (d: Device) =>
      new Request(`http://localhost/v1/admin/reviews/${rel!.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', 'idempotency-key': randomBytes(16).toString('base64url') },
        body: JSON.stringify({ outcome: 'approved', checklist: { permissions_minimal: true }, rationale: 'Example review.' }),
      });
    expect((await review(req(demo), id(rel!.id))).status).toBe(403);
    const ok = await review(req(reviewer), id(rel!.id));
    expect(releaseReviewedSchema.parse(await ok.json())).toMatchObject({ review_status: 'approved', reconsent_required: 1 });

    const home = storeHomeSchema.parse((await call(storeHome, demo, 'GET', `/v1/store/home?node_id=${nodeId}`, undefined, {})).body);
    expect(home.joined[0]).toMatchObject({ status: 'reconsent_required', share_bp: 10_000 });
    const old = await call(grant, demo, 'POST', `/v1/memberships/${membershipId}/permission-grants`, { permissions_hash: s.release.permissionsHash }, id(membershipId));
    expect(old.body).toMatchObject({ error: { code: 'permissions_changed', details: { permissions_hash: rel!.permissionsHash } } });
    const again = await call(grant, demo, 'POST', `/v1/memberships/${membershipId}/permission-grants`, { permissions_hash: rel!.permissionsHash }, id(membershipId));
    expect(permissionGrantedSchema.parse(again.body).membership).toMatchObject({ status: 'active', release_id: rel!.id });
  });

  it('leaves at once and gives up the share', async () => {
    const r = await call(leave, demo, 'DELETE', `/v1/memberships/${membershipId}`, undefined, id(membershipId));
    expect(membershipLeftSchema.parse(r.body)).toMatchObject({ id: membershipId, abandoned_leases: 0 });
    const home = storeHomeSchema.parse((await call(storeHome, demo, 'GET', `/v1/store/home?node_id=${nodeId}`, undefined, {})).body);
    expect(home.joined).toEqual([]);
    expect(home.node.share_total_bp).toBe(0);
  });
});
