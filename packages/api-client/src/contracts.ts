/**
 * Wire contracts for the Swarm Explorer API (SPEC 13). Shared by the website's route
 * handlers, the desktop client and the CLI, so both ends parse the same shapes.
 * All APIs are versioned under /v1 and errors are `{error:{code,message,details}}`.
 */
import { z } from 'zod';

export const API_VERSION = 'v1';

export const categorySchema = z.enum(['governance', 'mathematics', 'security', 'science', 'healthcare', 'public_goods', 'gaming']);
export type Category = z.infer<typeof categorySchema>;

/** Digests on the wire use the manifest form `sha256-<hex>` (SPEC 6.5). */
export const digestSchema = z.string().regex(/^sha256-[a-f0-9]{64}$/);
export const slugSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
const isoDate = z.iso.datetime({ offset: true });

export const healthSchema = z.object({ ok: z.literal(true), version: z.literal(API_VERSION) });

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const verificationMethodSchema = z.enum(['machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review']);

export const publisherRefSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** "verified" proves domain or GitHub organization control, not endorsement (SPEC 11.6). */
  badge: z.enum(['none', 'pending', 'verified', 'revoked']),
});

/**
 * Funding as a node sees it. Volunteer swarms pay impact only. A funded swarm with no
 * available pool credits leases no paid tasks (SPEC 9.2).
 */
export const fundingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('volunteer') }),
  z.object({ mode: z.literal('funded'), creditsPerAcceptedTask: z.number().int().positive(), poolStatus: z.enum(['available', 'empty']) }),
]);

export const swarmSummarySchema = z.object({
  slug: slugSchema,
  name: z.string(),
  summary: z.string(),
  category: categorySchema,
  publisher: publisherRefSchema,
  featured: z.boolean(),
  funding: fundingSchema,
  verification: z.array(verificationMethodSchema).min(1),
  models: z.object({ policy: z.enum(['any', 'class', 'diverse']), classes: z.array(z.string()), apiAllowed: z.boolean() }),
  harness: z.object({ name: z.string(), version: semverSchema, runtime: z.enum(['wasm', 'container']) }),
  permissions: z.object({
    network: z.array(z.string()),
    scratchDiskGb: z.number().nonnegative(),
    gpuCompute: z.boolean(),
    apiSpendDailyUsd: z.number().nonnegative().nullable(),
  }),
});
export type SwarmSummary = z.infer<typeof swarmSummarySchema>;

/** Acceptance rate shows its sample and time range, or says there is not enough history (SPEC 4.2). */
export const acceptanceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_enough_history') }),
  z.object({ status: z.literal('measured'), acceptedBp: z.number().int().min(0).max(10_000), sample: z.number().int().positive(), from: isoDate, to: isoDate }),
]);

export const swarmDetailSchema = swarmSummarySchema.extend({
  release: z.object({
    id: z.uuid(),
    manifestHash: digestSchema,
    permissionsHash: digestSchema,
    publishedAt: isoDate.nullable(),
    harnessHash: digestSchema,
    minClientVersion: semverSchema,
  }),
  resultsUrl: z.url(),
  qualification: z.object({ tasks: z.number().int().positive(), pass: z.number().int().positive() }),
  task: z.object({ timeoutS: z.number().int().positive(), maxParallelPerNode: z.number().int().positive(), urgentAllowed: z.boolean() }),
  verificationConfig: z.object({
    knownAnswerRate: z.number().nullable(),
    redundancyCount: z.number().int().nullable(),
    juryPanelSize: z.number().int().nullable(),
    pendingWindowS: z.number().int().nonnegative(),
  }),
  dataPolicy: z.object({ publicInputs: z.boolean(), retentionDays: z.number().int().nonnegative(), sensitiveDataProhibited: z.boolean() }),
  acceptance: acceptanceSchema,
  /** Public outcomes with receipts. Empty until real verified results exist (SPEC 16.1). */
  outcomes: z.array(z.object({ id: z.uuid(), title: z.string(), verifiedAt: isoDate, receiptUrl: z.string() })),
  trust: z.object({ releaseReviewed: z.boolean(), harnessReviewed: z.boolean(), signatureKeyId: z.string().nullable(), openReports: z.number().int().nonnegative() }),
  /** The signed manifest object, for clients that verify it themselves. */
  manifest: z.record(z.string(), z.unknown()),
});
export type SwarmDetail = z.infer<typeof swarmDetailSchema>;

export const swarmListSchema = z.object({ items: z.array(swarmSummarySchema) });
export const listSwarmsQuerySchema = z.object({ category: categorySchema.optional() });
export type ListSwarmsQuery = z.input<typeof listSwarmsQuerySchema>;

export const modelArtifactSchema = z.object({
  versionLabel: z.string(),
  contentHash: digestSchema,
  sizeBytes: z.number().int().positive(),
  contextLength: z.number().int().positive(),
  quantization: z.string(),
  runtimeFormats: z.array(z.string()),
  catalogVersion: z.number().int().nonnegative(),
  /** An Ollama tag, or `owner/repo@revision/file.gguf` on Hugging Face. Pinned by contentHash. */
  sourceRef: z.string().min(1).max(300),
});

export const modelSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  source: z.enum(['ollama', 'huggingface']),
  family: z.string(),
  modelClass: z.string(),
  licenseId: z.string(),
  artifacts: z.array(modelArtifactSchema),
  acceptedSwarms: z.array(slugSchema),
});
export type CatalogModel = z.infer<typeof modelSchema>;
export const modelListSchema = z.object({ items: z.array(modelSchema) });

export const fitStatusEnum = z.enum(['runs_well', 'runs_slowly', 'will_not_fit', 'unknown']);

/** GET /v1/models/{id}/fit?node_id= : estimated fit before download (SPEC 13.1). */
export const modelFitSchema = z.object({
  model: z.string().max(80),
  node_id: z.string().uuid(),
  observed_at: z.string().nullable(),
  artifacts: z.array(z.object({ content_hash: digestSchema, fit_status: fitStatusEnum, basis: z.literal('estimate'), reason: z.string() })),
});

/** POST /v1/nodes/{node_id}/models/{artifact}/benchmark (SPEC 13.1). `artifact` is the pinned content hash. */
export const benchmarkSubmitSchema = z
  .object({
    verified_hash: digestSchema,
    runtime: z.enum(['ollama', 'llama_cpp']),
    tokens_per_second: z.number().positive().max(100_000).nullable(),
    estimated_fit: fitStatusEnum,
  })
  .strict();
export const benchmarkAcceptedSchema = z.object({
  content_hash: digestSchema,
  benchmark_tps: z.number().nullable(),
  fit_status: fitStatusEnum,
  basis: z.enum(['estimate', 'benchmark']),
  calibration_version: z.number().int().nullable(),
});

/** POST /v1/me/license-acceptances: per user and artifact version (SPEC 5.4). */
export const licenseAcceptanceSchema = z.object({ content_hash: digestSchema, license_id: z.string().min(1).max(80) }).strict();
export const licenseAcceptedSchema = z.object({ content_hash: digestSchema, license_id: z.string(), accepted_at: z.string() });

export const harnessReleaseSchema = z.object({
  name: z.string(),
  version: semverSchema,
  publisher: publisherRefSchema,
  runtime: z.enum(['wasm', 'container']),
  bundleHash: digestSchema,
  minModelClass: z.string(),
  outputSchemaHash: digestSchema,
  sbomHash: digestSchema,
  signature: z.string(),
  reviewed: z.boolean(),
  revoked: z.boolean(),
  /** No bundle host exists yet; null until one does. */
  downloadUrl: z.url().nullable(),
});
export type HarnessReleaseInfo = z.infer<typeof harnessReleaseSchema>;

export const revocationSchema = z.object({
  id: z.uuid(),
  targetType: z.enum(['swarm', 'swarm_release', 'harness_release', 'model_artifact', 'publisher_key', 'client_version']),
  targetId: z.string(),
  reason: z.string(),
  severity: z.enum(['low', 'high', 'critical']),
  signedPayload: z.string(),
  effectiveAt: isoDate,
});
export const revocationFeedSchema = z.object({ items: z.array(revocationSchema), next: isoDate.nullable() });
export const revocationsQuerySchema = z.object({ since: isoDate.optional() });

/* ----------------------------------------------------------------------------
 * Task protocol (SPEC 13.3). Contracts only in M0; endpoints arrive in M5.
 * ------------------------------------------------------------------------- */

export const leaseSchema = z.object({
  lease_id: z.uuid(),
  task_id: z.uuid(),
  swarm_release_id: z.uuid(),
  deadline_at: isoDate,
  harness: z.object({ version: semverSchema, hash: digestSchema }),
  model_requirement: z.object({ policy: z.enum(['any', 'class', 'diverse']), allowed_classes: z.array(z.string()) }),
  input: z.object({ uri: z.url(), sha256: digestSchema }),
  output_schema_hash: digestSchema,
  reward: z.discriminatedUnion('funded', [
    z.object({ funded: z.literal(true), credits: z.number().int().positive() }),
    z.object({ funded: z.literal(false), credits: z.null() }),
  ]),
  permissions_hash: digestSchema,
});
/** A lease request returns zero or one lease. */
export const leaseResponseSchema = z.object({ lease: leaseSchema.nullable() });
export type Lease = z.infer<typeof leaseSchema>;

export const runRecordSchema = z.object({
  lease_id: z.uuid(),
  node_id: z.uuid(),
  model: z.object({ source: z.enum(['local', 'provider']), claimed_id: z.string().min(1), artifact_hash: digestSchema.nullable() }),
  harness_hash: digestSchema,
  tokens: z.object({ input: z.number().int().nonnegative().nullable(), output: z.number().int().nonnegative().nullable() }),
  elapsed_ms: z.number().int().nonnegative(),
  api_cost: z.object({ reported_usd_micros: z.number().int().nonnegative().nullable(), provider_request_ids: z.array(z.string()) }),
  output_sha256: digestSchema,
  client_version: semverSchema,
  signature: z.string().min(1),
});
export type RunRecord = z.infer<typeof runRecordSchema>;
