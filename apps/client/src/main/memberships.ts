/**
 * Join, qualification and leave in the main process (SPEC 3.2, 4.2, 13.2). Main makes every
 * signed call; the supervisor verifies the signed bundle and runs it in the sandbox. A link or the
 * renderer can only ask: every step re-checks with the server, and permissions are approved by
 * their exact hash.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  apiErrorSchema,
  bundleArchiveSchema,
  createApiClient,
  joinStartedSchema,
  membershipLeftSchema,
  permissionGrantedSchema,
  qualificationLeaseSchema,
  qualificationScoredSchema,
  storeHomeSchema,
  type JoinStarted,
  type MembershipView,
  type StoreHome,
  type SwarmDetail,
} from '@swarm-explorer/api-client';
import { canonicalJson } from '@swarm-explorer/schema';
import { bundleDigest } from '@swarm-explorer/schema/node';
import type { HarnessRunResult, HarnessRunSpec, MembershipJob, MembershipResult, MembershipsOverview, Permissions } from '../shared/node';
import type { AuthManager } from './auth';
import type { EncryptedCache } from './cache';
import type { ModelManager } from './models';

export type { MembershipResult, MembershipsOverview, Permissions } from '../shared/node';

type Deps = {
  auth: AuthManager;
  cache: () => EncryptedCache;
  apiBaseUrl: string;
  userDataDir: string;
  models: Pick<ModelManager, 'installed' | 'storage'>;
  nodeId: () => string | null;
  isPaused: () => boolean;
  run: (spec: HarnessRunSpec, signal: AbortSignal) => Promise<HarnessRunResult>;
  changed: () => void;
  fetch?: typeof fetch;
};

const GB = 1_000_000_000;
const fail = (code: string, message: string) => ({ ok: false as const, code, message });
const hex = (digest: string) => digest.replace(/^sha256-/, '');

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  const e = apiErrorSchema.safeParse(await res.json().catch(() => null));
  return e.success ? { code: e.data.error.code, message: e.data.error.message } : { code: `http_${res.status}`, message: 'The server could not do that right now.' };
}

export class MembershipManager {
  private home: StoreHome | null = null;
  private error: string | null = null;
  private jobs = new Map<string, MembershipJob & { ctl: AbortController }>();
  /** Permissions this app showed for review, by membership. Approval must match one exactly. */
  private reviews = new Map<string, { hash: string; permissions: Permissions }>();

  constructor(private d: Deps) {}

  private api() {
    return createApiClient({ baseUrl: this.d.apiBaseUrl, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
  }

  private granted(): Record<string, Permissions> {
    return this.d.cache().get<Record<string, Permissions>>('granted-permissions') ?? {};
  }

  overview(): MembershipsOverview {
    return { home: this.home, jobs: [...this.jobs.values()].map(({ ctl: _c, ...j }) => j), granted: this.granted(), error: this.error };
  }

  private setJob(m: Pick<MembershipJob, 'membershipId' | 'swarm'>, phase: MembershipJob['phase'], detail: string, ctl?: AbortController) {
    const prev = this.jobs.get(m.membershipId);
    this.jobs.set(m.membershipId, { ...m, phase, detail, ctl: ctl ?? prev?.ctl ?? new AbortController() });
    this.d.changed();
  }

  /** Store home from the server (SPEC 13.1). Null when signed out or offline; the last answer stays shown. */
  async refresh(): Promise<StoreHome | null> {
    const nodeId = this.d.nodeId();
    if (!nodeId || this.d.auth.getState().status !== 'signed_in') return null;
    try {
      await this.retryPendingLeaves();
      const res = await this.d.auth.signedFetch('GET', `/v1/store/home?node_id=${nodeId}`);
      const body = storeHomeSchema.safeParse(await res.json().catch(() => null));
      if (!res.ok || !body.success) return this.home;
      this.home = body.data;
      this.error = null;
      this.d.changed();
      return this.home;
    } catch {
      return this.home;
    }
  }

  /** Starts a join for the swarm's current reviewed release and returns the permissions to approve. */
  async startJoin(slug: string): Promise<MembershipResult<{ join: JoinStarted; swarm: SwarmDetail }>> {
    const nodeId = this.d.nodeId();
    if (this.d.auth.getState().status !== 'signed_in' || !nodeId) return fail('signed_out', 'Sign in to join a swarm.');
    let swarm: SwarmDetail;
    try {
      swarm = await this.api().getSwarm(slug);
    } catch {
      return fail('offline', 'The catalog could not be reached. Try again when you are online.');
    }
    if (swarm.harness.runtime !== 'wasm') return fail('runtime_unsupported', 'This swarm needs isolation this version of Henge does not provide.');
    try {
      const res = await this.d.auth.signedFetch('POST', `/v1/swarms/${slug}/memberships`, { node_id: nodeId, manifest_hash: swarm.release.manifestHash });
      if (!res.ok) return { ok: false, ...(await errorOf(res)) };
      const join = joinStartedSchema.safeParse(await res.json());
      if (!join.success) return fail('bad_response', 'The server sent a response Henge does not understand.');
      if (join.data.permissions_hash !== swarm.release.permissionsHash) return fail('permissions_changed', 'The permissions changed while you were reviewing. Review them again.');
      this.rememberAccepted(join.data.membership.id, join.data.models.map((x) => x.content_hash));
      this.reviews.set(join.data.membership.id, { hash: join.data.permissions_hash, permissions: join.data.permissions });
      await this.refresh();
      return { ok: true, join: join.data, swarm };
    } catch {
      return fail('offline', 'Henge could not reach the server.');
    }
  }

  /**
   * A release changed this swarm's permissions (SPEC 11.4): fetch the new set for review. Work
   * stays stopped until it is approved.
   */
  async reviewChange(membershipId: string): Promise<MembershipResult<{ swarm: SwarmDetail; previous: Permissions | null }>> {
    const m = (await this.refresh())?.joined.find((j) => j.id === membershipId);
    if (!m || m.status !== 'reconsent_required') return fail('nothing_to_review', 'This swarm has no permission change waiting.');
    try {
      const swarm = await this.api().getSwarm(m.swarm);
      this.reviews.set(membershipId, { hash: swarm.release.permissionsHash, permissions: swarm.permissions });
      return { ok: true, swarm, previous: this.granted()[membershipId] ?? null };
    } catch {
      return fail('offline', 'The catalog could not be reached.');
    }
  }

  /** Approves exactly the permissions shown for review, then qualifies (new joins) or resumes (reconsent). */
  async approve(membershipId: string, permissionsHash: string): Promise<MembershipResult<{ membership: MembershipView }>> {
    const reviewed = this.reviews.get(membershipId);
    if (!reviewed || reviewed.hash !== permissionsHash) return fail('review_first', 'Review the permissions before approving them.');
    const permissions = reviewed.permissions;
    try {
      const res = await this.d.auth.signedFetch('POST', `/v1/memberships/${membershipId}/permission-grants`, { permissions_hash: permissionsHash });
      if (!res.ok) return { ok: false, ...(await errorOf(res)) };
      const body = permissionGrantedSchema.safeParse(await res.json());
      if (!body.success) return fail('bad_response', 'The server sent a response Henge does not understand.');
      this.d.cache().set('granted-permissions', { ...this.granted(), [membershipId]: permissions });
      this.reviews.delete(membershipId);
      await this.refresh();
      if (body.data.membership.status === 'qualifying') void this.qualify(body.data.membership);
      return { ok: true, membership: body.data.membership };
    } catch {
      return fail('offline', 'Henge could not reach the server.');
    }
  }

  /** Runs qualification again, for example after a failed round or after Pause. */
  async retry(membershipId: string): Promise<MembershipResult> {
    const m = (await this.refresh())?.joined.find((j) => j.id === membershipId);
    if (!m || m.status !== 'qualifying') return fail('not_qualifying', 'This swarm is not waiting for qualification.');
    void this.qualify(m);
    return { ok: true };
  }

  /** Every qualifying membership continues after Resume. */
  resumeQualifying() {
    for (const m of this.home?.joined ?? []) if (m.status === 'qualifying' && !this.isRunning(m.id) && m.qualification?.outcome !== 'failed') void this.qualify(m);
  }

  private isRunning(id: string) {
    const j = this.jobs.get(id);
    return Boolean(j && ['downloading', 'verifying', 'running', 'submitting'].includes(j.phase));
  }

  /** Downloads the signed bundle into a private folder, accepting it only if its digest matches. */
  private async ensureBundle(swarm: SwarmDetail, signal: AbortSignal): Promise<{ dir: string; release: Awaited<ReturnType<ReturnType<MembershipManager['api']>['harnessRelease']>> }> {
    const release = await this.api().harnessRelease(swarm.harness.name, swarm.harness.version);
    if (release.bundleHash !== swarm.release.harnessHash) throw new Error('The harness release does not match the swarm manifest.');
    const root = path.join(this.d.userDataDir, 'harnesses');
    const dir = path.join(root, hex(release.bundleHash));
    try {
      if (bundleDigest(dir) === release.bundleHash) return { dir, release };
    } catch {
      // Not downloaded yet.
    }
    if (!release.downloadUrl) throw new Error('This release has no download location yet.');
    // Only the API host serves bundles for now; the digest check below protects integrity either way.
    if (new URL(release.downloadUrl).origin !== new URL(this.d.apiBaseUrl).origin) throw new Error('The bundle host is not allowed.');
    const res = await (this.d.fetch ?? fetch)(release.downloadUrl, { signal });
    const archive = bundleArchiveSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !archive.success || archive.data.bundleHash !== release.bundleHash) throw new Error('The bundle download was not valid.');
    const tmp = `${dir}.partial`;
    await rm(tmp, { recursive: true, force: true });
    for (const [rel, b64] of Object.entries(archive.data.files)) {
      const file = path.join(tmp, ...rel.split('/'));
      if (!file.startsWith(`${tmp}${path.sep}`)) throw new Error('The bundle has a bad path.');
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, Buffer.from(b64, 'base64'), { mode: 0o600 });
    }
    if (bundleDigest(tmp) !== release.bundleHash) {
      await rm(tmp, { recursive: true, force: true });
      throw new Error('The downloaded bundle does not match its pinned hash.');
    }
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    return { dir, release };
  }

  /** Accepted model hashes from the join answer, cached per membership; asked again if missing. */
  private async acceptedModels(m: MembershipView, swarm: SwarmDetail): Promise<string[]> {
    const cached = this.d.cache().get<Record<string, string[]>>('accepted-models')?.[m.id];
    if (cached?.length) return cached;
    const res = await this.d.auth.signedFetch('POST', `/v1/swarms/${m.swarm}/memberships`, { node_id: m.node_id, manifest_hash: swarm.release.manifestHash });
    const join = joinStartedSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !join.success) return [];
    const hashes = join.data.models.map((x) => x.content_hash);
    this.rememberAccepted(m.id, hashes);
    return hashes;
  }

  private rememberAccepted(membershipId: string, hashes: string[]) {
    this.d.cache().set('accepted-models', { ...(this.d.cache().get<Record<string, string[]>>('accepted-models') ?? {}), [membershipId]: hashes });
  }

  /** The installed model to use: the active one if the swarm accepts it, else the first accepted. */
  private pickModel(accepted: string[]) {
    const installed = this.d.models.installed();
    const active = this.d.models.storage().activeModel;
    return installed.find((m) => m.contentHash === active && accepted.includes(m.contentHash)) ?? installed.find((m) => accepted.includes(m.contentHash)) ?? null;
  }

  /**
   * Qualification (SPEC 3.2): lease a known-answer task, run it in the sandbox with the user's own
   * model, submit, repeat until the round passes or fails. It is not credited work.
   */
  private async qualify(m: MembershipView) {
    if (this.isRunning(m.id)) return;
    const ctl = new AbortController();
    const job = { membershipId: m.id, swarm: m.swarm };
    if (this.d.isPaused()) return this.setJob(job, 'stopped', 'Paused. Qualification continues when you resume.', ctl);
    this.setJob(job, 'downloading', 'Downloading the signed harness', ctl);
    try {
      const swarm = await this.api().getSwarm(m.swarm);
      const { dir, release } = await this.ensureBundle(swarm, ctl.signal);
      if (!release.signingKey) throw new Error('The release has no registered signing key.');
      const feed = await this.api().revocations();
      const revoked = {
        harnessReleases: feed.items.filter((r) => r.targetType === 'harness_release').map((r) => r.targetId),
        publisherKeys: feed.items.filter((r) => r.targetType === 'publisher_key').map((r) => r.targetId),
      };
      // The server decides which installed models the swarm's policy accepts (SPEC 6.2).
      const accepted = await this.acceptedModels(m, swarm);
      for (;;) {
        if (ctl.signal.aborted) return;
        if (this.d.isPaused()) return this.setJob(job, 'stopped', 'Paused. Qualification continues when you resume.');
        const lres = await this.d.auth.signedFetch('POST', `/v1/memberships/${m.id}/qualification/lease`);
        if (!lres.ok) {
          const e = await errorOf(lres);
          return this.setJob(job, 'error', e.message);
        }
        const lease = qualificationLeaseSchema.parse(await lres.json());
        const q = lease.qualification;
        const model = this.pickModel(accepted);
        if (!model) return this.setJob(job, 'error', 'None of your downloaded models is accepted by this swarm.');
        this.setJob(job, 'running', `Known answer ${q.attempts + 1} of up to ${q.tasks} (needs ${q.pass}), on ${model.displayName}`);
        const spec: HarnessRunSpec = {
          bundleDir: dir,
          release: { publisher: release.publisher.slug, name: release.name, version: release.version, bundleHash: release.bundleHash, signature: release.signature, reviewed: release.reviewed, revoked: release.revoked },
          key: { ...release.signingKey, publisher: release.publisher.slug },
          revoked,
          swarm: m.swarm,
          permissions: { network: swarm.permissions.network, scratchBytes: Math.round(swarm.permissions.scratchDiskGb * GB) },
          permissionsHash: m.permissions_hash,
          model: { contentHash: model.contentHash, modelClass: model.slug },
          lease: `qualification:${m.id}`,
          timeoutS: swarm.task.timeoutS,
          input: lease.task.input,
        };
        const r = await this.d.run(spec, ctl.signal);
        if (ctl.signal.aborted || r.status === 'cancelled') return;
        if (r.status === 'bundle_rejected' || r.status === 'refused') return this.setJob(job, 'error', r.detail);
        // A run that ends without a valid answer is submitted as an empty answer: it counts as wrong.
        const output = r.status === 'ok' && r.output ? r.output : {};
        this.setJob(job, 'submitting', 'Sending the answer for checking');
        const body = {
          task_id: lease.task.id,
          output,
          output_sha256: `sha256-${createHash('sha256').update(canonicalJson(output)).digest('hex')}`,
          run: { model_artifact_hash: model.contentHash, harness_hash: release.bundleHash, screen: r.screen ?? { verdict: 'allow' as const, reasons: [], screener: 'none' } },
        };
        const sres = await this.d.auth.signedFetch('POST', `/v1/memberships/${m.id}/qualification/results`, body);
        if (!sres.ok) return this.setJob(job, 'error', (await errorOf(sres)).message);
        const scored = qualificationScoredSchema.parse(await sres.json());
        await this.refresh();
        if (scored.qualification.outcome === 'passed') return this.setJob(job, 'done', `Qualified: ${scored.qualification.passed} of ${scored.qualification.attempts} known answers matched.`);
        if (scored.qualification.outcome === 'failed') return this.setJob(job, 'error', scored.qualification.retry_reason ?? 'Qualification did not pass.');
      }
    } catch (e) {
      if (!ctl.signal.aborted) this.setJob(job, 'error', e instanceof Error ? e.message.slice(0, 200) : 'Qualification stopped.');
    }
  }

  /**
   * Leave (SPEC 3.2): stop local work first, then tell the server, then remove the swarm's scratch
   * data and its harness unless another joined swarm uses it. Earned credits stay.
   */
  async leave(membershipId: string): Promise<MembershipResult<{ abandonedLeases: number }>> {
    const m = this.home?.joined.find((j) => j.id === membershipId);
    const job = this.jobs.get(membershipId);
    job?.ctl.abort();
    this.jobs.delete(membershipId);
    let abandoned = 0;
    let pending = false;
    try {
      const res = await this.d.auth.signedFetch('DELETE', `/v1/memberships/${membershipId}`);
      if (res.ok) abandoned = membershipLeftSchema.parse(await res.json()).abandoned_leases;
      else if (res.status >= 500) pending = true;
      else if ((await errorOf(res)).code !== 'membership_left') return { ok: false, ...(await errorOf(res.clone())) };
    } catch {
      pending = true;
    }
    if (pending) this.d.cache().set('pending-leaves', [...new Set([...(this.d.cache().get<string[]>('pending-leaves') ?? []), membershipId])]);
    if (m) await this.cleanUp(m);
    const g = this.granted();
    delete g[membershipId];
    this.d.cache().set('granted-permissions', g);
    if (this.home) this.home = { ...this.home, joined: this.home.joined.filter((j) => j.id !== membershipId) };
    this.d.changed();
    if (!pending) await this.refresh();
    return { ok: true, abandonedLeases: abandoned };
  }

  private async cleanUp(m: MembershipView) {
    if (/^[a-z0-9][a-z0-9.-]{0,62}$/.test(m.swarm) && !m.swarm.includes('..')) await rm(path.join(this.d.userDataDir, 'scratch', m.swarm), { recursive: true, force: true });
    const stillUsed = (this.home?.joined ?? []).some((j) => j.id !== m.id && j.harness.hash === m.harness.hash);
    if (!stillUsed && /^sha256-[a-f0-9]{64}$/.test(m.harness.hash)) await rm(path.join(this.d.userDataDir, 'harnesses', hex(m.harness.hash)), { recursive: true, force: true });
  }

  private async retryPendingLeaves() {
    const pending = this.d.cache().get<string[]>('pending-leaves') ?? [];
    if (!pending.length) return;
    const left: string[] = [];
    for (const id of pending) {
      const res = await this.d.auth.signedFetch('DELETE', `/v1/memberships/${id}`).catch(() => null);
      if (!res || res.status >= 500) left.push(id);
    }
    this.d.cache().set('pending-leaves', left);
  }

  /** Stops every local run, for Pause and sign out. */
  stopAll(reason: string) {
    for (const j of this.jobs.values()) {
      if (['downloading', 'verifying', 'running', 'submitting'].includes(j.phase)) {
        j.ctl.abort();
        this.jobs.set(j.membershipId, { ...j, phase: 'stopped', detail: reason, ctl: new AbortController() });
      }
    }
    this.d.changed();
  }
}
