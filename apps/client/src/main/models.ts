/**
 * Model manager (SPEC 5.4, 16.4 M2) in the main process. The supervisor does the downloading,
 * hashing and benchmarking; this side decides whether a download may start at all:
 *
 * - the artifact comes from the API catalog fetched here, never from renderer-supplied data;
 * - the license was accepted for this artifact version;
 * - a disk budget is set and the download fits it (least-used removals are only suggested);
 * - the model is not "Will not fit" and its runtime is present.
 *
 * The active model is never removed, by eviction or otherwise, and models the user already had
 * in Ollama are never removed by us.
 */
import { benchmarkAcceptedSchema, createApiClient, licenseAcceptedSchema, type CatalogModel } from '@swarm-explorer/api-client';
import { canRemove, estimateFit, memoryFacts, planDownload, usedBytes } from '@swarm-explorer/node-core';
import { z } from 'zod';
import {
  blockedModelSchema,
  installedModelSchema,
  storageSchema,
  type ArtifactRef,
  type BlockedModel,
  type Detection,
  type InstallOutcomeMsg,
  type InstalledModel,
  type ModelActionResult,
  type ModelInstallInput,
  type ModelJob,
  type ModelsOverview,
  type Storage,
} from '../shared/node';
import type { AuthManager } from './auth';
import type { EncryptedCache } from './cache';

const GiB = 1024 ** 3;

export type SupervisorRpc = {
  install(a: ArtifactRef, onProgress: (completed: number, total: number | null) => void): Promise<InstallOutcomeMsg>;
  benchmark(runtime: ArtifactRef['runtime'], location: string): Promise<{ tps: number | null; detail: string | null }>;
  remove(runtime: ArtifactRef['runtime'], location: string): Promise<boolean>;
};

type Deps = {
  auth: AuthManager;
  cache: () => EncryptedCache;
  apiBaseUrl: string;
  rpc: SupervisorRpc;
  detection: () => Detection | null;
  nodeId: () => string | null;
  changed: () => void;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
};

const fail = (code: string, message: string, extra: Partial<Extract<ModelActionResult, { ok: false }>> = {}): ModelActionResult => ({ ok: false, code, message, ...extra });
const gb = (n: number) => `${Math.round((n / GiB) * 10) / 10} GB`;

export class ModelManager {
  private job: ModelJob | null = null;

  constructor(private d: Deps) {}

  private read<T>(name: string, schema: z.ZodType<T>, fallback: T): T {
    const v = schema.safeParse(this.d.cache().get(name));
    return v.success ? v.data : fallback;
  }

  installed(): InstalledModel[] {
    return this.read('models-installed', z.array(installedModelSchema), []);
  }
  private saveInstalled(list: InstalledModel[]) {
    this.d.cache().set('models-installed', list);
  }
  blocked(): BlockedModel[] {
    return this.read('models-blocked', z.array(blockedModelSchema), []);
  }
  storage(): Storage {
    return this.read('storage', storageSchema, { diskBudgetBytes: null, activeModel: null });
  }
  private saveStorage(s: Storage) {
    this.d.cache().set('storage', s);
  }
  private licenses(): Array<{ contentHash: string; licenseId: string; sharedAt: number | null }> {
    return this.read('license-acceptances', z.array(z.object({ contentHash: z.string(), licenseId: z.string(), sharedAt: z.number().nullable() })), []);
  }

  /** Never removable: the active model. Leased models join this set in M5. */
  protectedHashes(): Set<string> {
    const a = this.storage().activeModel;
    return new Set(a ? [a] : []);
  }

  overview(): ModelsOverview {
    const installed = this.installed();
    return {
      installed,
      blocked: this.blocked(),
      job: this.job,
      storage: this.storage(),
      usedBytes: usedBytes(installed),
      protected: [...this.protectedHashes()],
      acceptedLicenses: this.licenses().map((l) => l.contentHash),
    };
  }

  setDiskBudget(bytes: number): ModelActionResult {
    const free = this.d.detection()?.hardware.freeDiskBytes ?? null;
    const used = usedBytes(this.installed());
    if (bytes < GiB) return fail('budget_too_small', 'Choose at least 1 GB.');
    if (free !== null && bytes > free + used) return fail('budget_over_free', `This computer has ${gb(free)} free.`);
    this.saveStorage({ ...this.storage(), diskBudgetBytes: bytes });
    this.d.changed();
    return { ok: true };
  }

  setActive(contentHash: string): ModelActionResult {
    if (!this.installed().some((m) => m.contentHash === contentHash)) return fail('not_installed', 'That model is not installed.');
    this.saveStorage({ ...this.storage(), activeModel: contentHash });
    this.d.changed();
    return { ok: true };
  }

  private async catalogArtifact(slug: string, contentHash: string): Promise<{ model: CatalogModel; artifact: CatalogModel['artifacts'][number] } | null> {
    const { items } = await createApiClient({ baseUrl: this.d.apiBaseUrl, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) }).listModels();
    const model = items.find((m) => m.slug === slug);
    const artifact = model?.artifacts.find((a) => a.contentHash === contentHash);
    return model && artifact ? { model, artifact } : null;
  }

  async install(input: ModelInstallInput): Promise<ModelActionResult> {
    if (this.job) return fail('busy', 'Another model is downloading. Wait for it to finish.');
    const det = this.d.detection();
    if (!det) return fail('not_detected', 'Hardware has not been checked yet.');
    let found: Awaited<ReturnType<ModelManager['catalogArtifact']>>;
    try {
      found = await this.catalogArtifact(input.slug, input.contentHash);
    } catch {
      return fail('catalog_offline', 'The model catalog could not be reached.');
    }
    if (!found) return fail('not_in_catalog', 'That model version is not in the catalog.');
    const { model, artifact } = found;
    const runtime = artifact.runtimeFormats.includes('ollama') ? 'ollama' : artifact.runtimeFormats.includes('gguf') ? 'llama_cpp' : null;
    if (!runtime) return fail('runtime_unsupported', 'This model needs a runtime Henge does not support.');
    const rt = det.runtimes.find((r) => r.kind === runtime);
    if (rt?.status !== 'found') return fail('runtime_missing', runtime === 'ollama' ? 'Install and start Ollama first, then check hardware again.' : 'Install llama.cpp first, then check hardware again.');
    if (this.installed().some((m) => m.contentHash === artifact.contentHash)) return fail('already_installed', 'This model is already installed.');

    const fit = estimateFit(artifact.sizeBytes, memoryFacts(det.hardware));
    if (fit.status === 'will_not_fit') return fail('will_not_fit', 'This model will not fit on this computer.');
    if (det.hardware.freeDiskBytes !== null && artifact.sizeBytes > det.hardware.freeDiskBytes) return fail('disk_full', `This model needs ${gb(artifact.sizeBytes)} and the disk has ${gb(det.hardware.freeDiskBytes)} free.`);

    if (input.diskBudgetBytes !== undefined) {
      const r = this.setDiskBudget(input.diskBudgetBytes);
      if (!r.ok) return r;
    }
    const plan = planDownload(this.installed(), this.storage().diskBudgetBytes, artifact.sizeBytes, this.protectedHashes());
    if (!plan.ok) {
      if (plan.reason === 'no_budget') return fail('no_budget', 'Choose a disk budget first.');
      if (plan.reason === 'larger_than_budget') return fail('larger_than_budget', `This model is larger than your ${gb(this.storage().diskBudgetBytes!)} disk budget.`);
      return plan.suggestions.length
        ? fail('over_budget', `Free ${gb(plan.needBytes)} within your disk budget first. Least-used models are suggested; your active model is kept.`, { suggestions: plan.suggestions })
        : fail('over_budget', `Not enough room in your disk budget, and your active model is never removed to make space. Raise the budget or remove other models.`, { suggestions: [] });
    }

    this.recordLicense(artifact.contentHash, model.licenseId);
    this.job = { contentHash: artifact.contentHash, slug: model.slug, phase: 'downloading', completed: 0, total: artifact.sizeBytes };
    this.d.changed();
    let outcome: InstallOutcomeMsg;
    try {
      outcome = await this.d.rpc.install({ contentHash: artifact.contentHash, runtime, sourceRef: artifact.sourceRef, sizeBytes: artifact.sizeBytes }, (completed, total) => {
        if (this.job) this.job = { ...this.job, completed, total: total ?? this.job.total };
        this.d.changed();
      });
    } catch {
      outcome = { ok: false, reason: 'download_failed', detail: 'The download stopped.' };
    }
    if (!outcome.ok) {
      this.job = null;
      if (outcome.reason === 'hash_mismatch' || outcome.reason === 'tag_drift') {
        const others = this.blocked().filter((b) => b.contentHash !== artifact.contentHash);
        this.d.cache().set('models-blocked', [
          ...others,
          { contentHash: artifact.contentHash, slug: model.slug, reason: outcome.reason, detail: outcome.detail, expected: outcome.expected ?? null, actual: outcome.actual ?? null, at: Date.now() },
        ]);
      }
      this.d.changed();
      return fail(outcome.reason, outcome.detail);
    }
    if (outcome.verifiedHash !== artifact.contentHash) {
      // Defense in depth: the supervisor said ok, but main holds the pin.
      this.job = null;
      this.d.changed();
      return fail('hash_mismatch', 'The verified hash did not match the catalog.');
    }

    const entry: InstalledModel = {
      contentHash: artifact.contentHash,
      slug: model.slug,
      displayName: model.displayName,
      runtime,
      sourceRef: artifact.sourceRef,
      sizeBytes: artifact.sizeBytes,
      location: outcome.location,
      managed: outcome.managed,
      installedAt: Date.now(),
      lastUsedAt: null,
      verifiedHash: outcome.verifiedHash,
      benchmarkTps: null,
      benchmarkDetail: null,
      fit: { status: fit.status, basis: 'estimate', reason: fit.reason },
      benchmarkSharedAt: null,
    };
    this.saveInstalled([...this.installed(), entry]);
    this.d.cache().set('models-blocked', this.blocked().filter((b) => b.contentHash !== artifact.contentHash));
    if (!this.storage().activeModel) this.saveStorage({ ...this.storage(), activeModel: entry.contentHash });
    await this.benchmark(entry.contentHash);
    return { ok: true };
  }

  /** Short tokens-per-second benchmark after install (SPEC 5.1 step 5); also on request. */
  async benchmark(contentHash: string): Promise<ModelActionResult> {
    const m = this.installed().find((x) => x.contentHash === contentHash);
    if (!m) return fail('not_installed', 'That model is not installed.');
    this.job = { contentHash, slug: m.slug, phase: 'benchmarking', completed: 0, total: null };
    this.d.changed();
    const r = await this.d.rpc.benchmark(m.runtime, m.location).catch(() => ({ tps: null, detail: 'The benchmark did not run.' }));
    this.job = null;
    // Fit stays the memory fact; the benchmark is recorded as measured tokens per second only.
    const fit = estimateFit(m.sizeBytes, memoryFacts(this.d.detection()!.hardware));
    this.update(contentHash, { benchmarkTps: r.tps, benchmarkDetail: r.detail, fit: { status: fit.status, basis: fit.basis, reason: fit.reason }, benchmarkSharedAt: null });
    this.d.changed();
    await this.share();
    return { ok: true };
  }

  private update(contentHash: string, patch: Partial<InstalledModel>) {
    this.saveInstalled(this.installed().map((x) => (x.contentHash === contentHash ? { ...x, ...patch } : x)));
  }

  async remove(contentHash: string): Promise<ModelActionResult> {
    const list = this.installed();
    const ok = canRemove(contentHash, list, this.protectedHashes());
    if (!ok.ok) {
      return ok.reason === 'protected'
        ? fail('protected', 'This is your active model. Choose another active model first.')
        : ok.reason === 'not_managed'
          ? fail('not_managed', 'You installed this model in Ollama yourself, so Henge leaves it alone.')
          : fail('not_installed', 'That model is not installed.');
    }
    const m = list.find((x) => x.contentHash === contentHash)!;
    if (!(await this.d.rpc.remove(m.runtime, m.location).catch(() => false))) return fail('remove_failed', 'The model could not be removed.');
    this.saveInstalled(this.installed().filter((x) => x.contentHash !== contentHash));
    this.d.changed();
    return { ok: true };
  }

  private recordLicense(contentHash: string, licenseId: string) {
    const list = this.licenses().filter((l) => l.contentHash !== contentHash);
    this.d.cache().set('license-acceptances', [...list, { contentHash, licenseId, sharedAt: null }]);
  }

  /** Sends unshared license acceptances and benchmarks. Safe to call often; offline is fine. */
  async share() {
    const nodeId = this.d.nodeId();
    if (this.d.auth.getState().status !== 'signed_in') return;
    try {
      for (const l of this.licenses().filter((x) => x.sharedAt === null)) {
        const res = await this.d.auth.signedFetch('POST', '/v1/me/license-acceptances', { content_hash: l.contentHash, license_id: l.licenseId });
        if (res.ok && licenseAcceptedSchema.safeParse(await res.json()).success) {
          this.d.cache().set('license-acceptances', this.licenses().map((x) => (x.contentHash === l.contentHash ? { ...x, sharedAt: Date.now() } : x)));
        }
      }
      if (!nodeId) return;
      for (const m of this.installed().filter((x) => x.benchmarkSharedAt === null)) {
        const res = await this.d.auth.signedFetch('POST', `/v1/nodes/${nodeId}/models/${m.contentHash}/benchmark`, {
          verified_hash: m.verifiedHash,
          runtime: m.runtime,
          tokens_per_second: m.benchmarkTps,
          estimated_fit: m.fit.status,
        });
        const body = benchmarkAcceptedSchema.safeParse(await res.json().catch(() => null));
        if (!res.ok || !body.success) continue;
        this.update(m.contentHash, { benchmarkSharedAt: Date.now() });
      }
      this.d.changed();
    } catch {
      // Offline; the next sign in or report tries again.
    }
  }
}
