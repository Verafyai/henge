/**
 * `toManifestV1(henge)` (spin-out spec v2, 6.3): map a `.henge` file onto ManifestV1 so the existing
 * node-core, policy and sandbox code keeps working, then run the ManifestV1 schema and invariants.
 *
 * Some ManifestV1 fields have no `.henge` v1 source (category, impact weight, funding, urgent
 * tasks, a harness bundle hash for wasm harnesses). They come from `ManifestContext`; nothing
 * is guessed. A missing one surfaces as a ManifestV1 schema issue.
 */
import { normalizeDigest } from './canonical';
import type { HengeV1 } from './henge-v1';
import type { Category, Digest, ManifestResult, ManifestV1 } from './types';
import { validateManifest } from './validate';

export interface ManifestContext {
  /** https URL of the bundle root (ending in `/`), used to turn bundle-relative paths into https URLs. */
  baseUrl?: string;
  category?: Category;
  categoryWeight?: number;
  /** Harness bundle digest. Defaults to `runtime.harness.hash`, then to the digest in `runtime.harness.image`. */
  harnessHash?: Digest;
  /** Defaults to the first benchmark's leaderboard, resolved against `baseUrl`. */
  resultsUrl?: string;
  /** Defaults to a volunteer swarm: not funded, no reward, no pool. */
  credits?: ManifestV1['credits'];
  /** Defaults to false. */
  urgentAllowed?: boolean;
}

const resolve = (p: string | undefined, base: string | undefined): string | undefined => {
  if (!p) return undefined;
  if (p.startsWith('https://')) return p;
  if (!base) return undefined;
  try {
    return new URL(p, base).toString();
  } catch {
    return undefined;
  }
};

/** `<publisher>/<swarm>` becomes `<publisher>--<swarm>`, which fits the ManifestV1 id pattern. */
export function manifestIdForHenge(hengeId: string): string {
  return hengeId.replace('/', '--');
}

/** The ManifestV1-shaped object before validation. Fields with no source are left out. */
export function hengeToManifestCandidate(h: HengeV1, ctx: ManifestContext = {}): Record<string, unknown> {
  const harness = h.runtime.harness;
  const imageDigest = harness.image ? normalizeDigest(harness.image.split('@')[1] ?? '') : null;
  const hash = ctx.harnessHash ?? harness.hash ?? imageDigest ?? undefined;
  const m = h.participation.models;
  const budget = h.participation.budget;
  const scratch = h.participation.compute.scratch_disk_gb;
  const extensions = Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('x-')));
  const out: Record<string, unknown> = {
    manifest_version: 1,
    id: manifestIdForHenge(h.id),
    name: h.name,
    publisher: h.id.split('/')[0],
    category: ctx.category,
    summary: h.summary,
    harness: { name: harness.name, version: harness.version, hash, runtime: harness.runtime },
    models: {
      policy: m.policy,
      ...(m.class ? { class: m.class } : {}),
      ...(m.allowed_classes ? { allowed_classes: m.allowed_classes } : {}),
      api_allowed: m.byo_api_key,
      ...(m.diversity ? { diversity: { min_families: m.diversity.min_families, min_accounts: m.diversity.min_accounts } } : {}),
    },
    verification: h.task.verification,
    verification_config: h.task.verification_config,
    permissions: {
      network: h.task.permissions.network,
      // The permission is the ceiling a member may grant, so the range's max wins over its default.
      scratch_disk_gb: scratch.max ?? scratch.default ?? undefined,
      gpu_compute: h.participation.compute.gpu.allowed,
      api_spend_daily_usd: budget.currency === 'USD' ? budget.daily_cap.default : null,
    },
    credits: ctx.credits ?? { funded: false, per_accepted_task: null, pool_id: null },
    impact: ctx.categoryWeight === undefined ? undefined : { category_weight: ctx.categoryWeight },
    task: {
      timeout_s: h.task.timeout_s,
      max_parallel_per_node: h.task.max_parallel_per_node,
      urgent_allowed: ctx.urgentAllowed ?? false,
      input_schema: resolve(h.task.input_schema, ctx.baseUrl),
      output_schema: resolve(h.task.output_schema, ctx.baseUrl),
    },
    qualification: h.admission.requirements.qualification,
    results_url: ctx.resultsUrl ?? resolve(h.benchmarks[0]?.leaderboard, ctx.baseUrl),
    coordinator: h.runtime.coordinator,
    data_policy: h.data_policy,
    min_client_version: h.admission.requirements.min_client_version,
    ...extensions,
    'x-henge': { id: h.id, version: h.version },
  };
  // JSON round trip drops the undefined fields, so the schema reports each as missing.
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

/** Convert, then run `manifestV1Schema` and every existing ManifestV1 invariant on the result. */
export function toManifestV1(h: HengeV1, ctx: ManifestContext = {}): ManifestResult {
  return validateManifest(hengeToManifestCandidate(h, ctx));
}
