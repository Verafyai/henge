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
  /** The publisher key named by `signature`, so a node can verify the bundle (SPEC 11.6). */
  signingKey: z.object({ keyId: z.string(), publicKey: z.string(), status: z.enum(['active', 'revoked']) }).nullable(),
  /** Where the bundle archive can be fetched. The node checks its digest and signature, so the host is not trusted. */
  downloadUrl: z.url().nullable(),
});

/**
 * A harness bundle archive: every file of the bundle directory, base64 encoded. The node writes the
 * files to a private folder and accepts them only if the folder digest equals `bundleHash`.
 */
export const bundleArchiveSchema = z.object({
  format: z.literal('henge-bundle-v1'),
  bundleHash: digestSchema,
  files: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/), z.string().max(8 * 1024 * 1024)),
});
export type BundleArchive = z.infer<typeof bundleArchiveSchema>;
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
 * Task protocol (SPEC 13.3), served by the hosted coordinator from M5. Device-signed. Nodes always
 * pull; the coordinator never opens a connection to a node.
 * ------------------------------------------------------------------------- */

/** Lease states, exactly SPEC 7.3. M5 moves leases up to `submitted`; verification (M6) does the rest. */
export const leaseStatusSchema = z.enum(['leased', 'running', 'submitted', 'verifying', 'pending', 'settled', 'rejected', 'abandoned', 'expired', 'clawed_back']);
export type LeaseStatus = z.infer<typeof leaseStatusSchema>;

export const leaseSchema = z.object({
  lease_id: z.uuid(),
  task_id: z.uuid(),
  swarm: slugSchema,
  swarm_release_id: z.uuid(),
  status: leaseStatusSchema,
  urgent: z.boolean(),
  deadline_at: isoDate,
  harness: z.object({ version: semverSchema, hash: digestSchema }),
  model_requirement: z.object({ policy: z.enum(['any', 'class', 'diverse']), allowed_classes: z.array(z.string()) }),
  /** A device-signed, lease-scoped URL; it answers only while the lease is running. */
  input: z.object({ uri: z.url(), sha256: digestSchema }),
  output_schema_hash: digestSchema,
  reward: z.discriminatedUnion('funded', [
    z.object({ funded: z.literal(true), credits: z.number().int().positive() }),
    z.object({ funded: z.literal(false), credits: z.null() }),
  ]),
  permissions_hash: digestSchema,
});
export type Lease = z.infer<typeof leaseSchema>;

/**
 * POST /v1/coordinators/{swarm}/leases. API mode is off (decision 2026-11-25), so there is no spend
 * reservation, and reputation tokens arrive with reputation (M6); both are sent as null.
 */
export const leaseRequestSchema = z
  .object({
    node_id: z.uuid(),
    mode: z.literal('local'),
    model_artifact_hash: digestSchema,
    reputation_token: z.null(),
    spend_reservation: z.null(),
  })
  .strict();

export const leaseUnavailableSchema = z.enum(['no_tasks', 'pool_empty', 'paid_leasing_unavailable']);
export type LeaseUnavailable = z.infer<typeof leaseUnavailableSchema>;

/** A lease request returns zero or one lease; with zero, `unavailable` says why. */
export const leaseResponseSchema = z.object({
  lease: leaseSchema.nullable(),
  unavailable: z.object({ code: leaseUnavailableSchema, message: z.string() }).nullable(),
});

/** POST /v1/leases/{id}/start: Leased to Running once the node verified its pins (SPEC 7.3). */
export const leaseStartSchema = z.object({ harness_hash: digestSchema, permissions_hash: digestSchema, model_artifact_hash: digestSchema }).strict();
export const leaseInputSchema = z.object({ lease_id: z.uuid(), input: z.record(z.string(), z.unknown()), input_sha256: digestSchema });
export const leaseStartedSchema = leaseInputSchema.extend({ status: z.literal('running'), deadline_at: isoDate });

/** POST /v1/leases/{id}/renew. The coordinator may refuse (409 renewal_refused). */
export const leaseRenewedSchema = z.object({ lease_id: z.uuid(), deadline_at: isoDate, renewals: z.number().int().nonnegative() });

/** POST /v1/leases/{id}/abandon: an immediate, unpaid return. */
export const abandonReasonSchema = z.enum(['paused', 'left', 'run_rules', 'local_failure', 'signed_out', 'pin_mismatch']);
export type AbandonReason = z.infer<typeof abandonReasonSchema>;
export const leaseAbandonSchema = z.object({ reason: abandonReasonSchema }).strict();
export const leaseAbandonedSchema = z.object({ lease_id: z.uuid(), status: leaseStatusSchema, requeued: z.boolean() });

export const runRecordSchema = z
  .object({
    lease_id: z.uuid(),
    node_id: z.uuid(),
    model: z.object({ source: z.enum(['local', 'provider']), claimed_id: z.string().min(1).max(120), artifact_hash: digestSchema.nullable() }).strict(),
    harness_hash: digestSchema,
    tokens: z.object({ input: z.number().int().nonnegative().nullable(), output: z.number().int().nonnegative().nullable() }).strict(),
    elapsed_ms: z.number().int().nonnegative(),
    api_cost: z.object({ reported_usd_micros: z.number().int().nonnegative().nullable(), provider_request_ids: z.array(z.string().max(200)).max(64) }).strict(),
    output_sha256: digestSchema,
    client_version: semverSchema,
    /** Ed25519 device signature, base64url, over `runRecordMessage` of the record without this field. */
    signature: z.string().regex(/^[A-Za-z0-9_-]{80,90}$/),
  })
  .strict();
export type RunRecord = z.infer<typeof runRecordSchema>;

/** The bytes a device signs for a run record: a domain tag and the canonical JSON of the record minus `signature`. */
export function runRecordMessage(canonicalRecordWithoutSignature: string): string {
  return `swarm-explorer-run-record-v1\n${canonicalRecordWithoutSignature}`;
}

/** POST /v1/leases/{id}/results. Idempotent by lease id and output hash. */
export const resultSubmitSchema = z.object({ output: z.record(z.string(), z.unknown()), output_sha256: digestSchema, run_record: runRecordSchema }).strict();
export const resultSubmittedSchema = z.object({
  lease_id: z.uuid(),
  result_id: z.uuid(),
  status: leaseStatusSchema,
  /** Late and after-abandon results are recorded and never paid (SPEC 7.3). */
  disposition: z.enum(['on_time', 'late', 'after_abandon']),
  duplicate: z.boolean(),
  /** True only for an on-time result; it now waits for the swarm's verifier (M6). */
  awaiting_verification: z.boolean(),
});

/** GET /v1/leases/{id}: status for recovery. */
export const leaseViewSchema = z.object({
  lease: leaseSchema,
  result: z.object({ id: z.uuid(), output_sha256: digestSchema, disposition: z.enum(['on_time', 'late', 'after_abandon']), submitted_at: isoDate }).nullable(),
});

/** POST /v1/swarms/{id}/tasks:batch: the publisher uploads tasks to the hosted coordinator. */
export const taskBatchSchema = z
  .object({
    tasks: z
      .array(z.object({ coordinator_task_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/), input: z.record(z.string(), z.unknown()), urgent: z.boolean().optional() }).strict())
      .min(1)
      .max(500),
  })
  .strict();
export const taskBatchAcceptedSchema = z.object({ accepted: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative() });

/** PATCH /v1/nodes/{id}/shares: every qualified membership, basis points summing to 10,000 (SPEC 7.1). */
export const sharesUpdateSchema = z.object({ shares: z.array(z.object({ membership_id: z.uuid(), share_bp: z.number().int().min(0).max(10_000) }).strict()).min(1).max(64) }).strict();
export const sharesUpdatedSchema = z.object({ node_id: z.uuid(), customized: z.boolean(), shares: z.array(z.object({ membership_id: z.uuid(), share_bp: z.number().int() })) });

/* ----------------------------------------------------------------------------
 * Store home, join and qualification (SPEC 13.1, 13.2). Node-signed.
 * ------------------------------------------------------------------------- */

export const membershipStatusSchema = z.enum(['joining', 'qualifying', 'active', 'paused', 'reconsent_required', 'left']);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const qualificationProgressSchema = z.object({
  id: z.uuid(),
  tasks: z.number().int().positive(),
  pass: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  outcome: z.enum(['in_progress', 'passed', 'failed']),
  retry_reason: z.string().nullable(),
});
export type QualificationProgress = z.infer<typeof qualificationProgressSchema>;

export const membershipSchema = z.object({
  id: z.uuid(),
  swarm: slugSchema,
  node_id: z.uuid(),
  status: membershipStatusSchema,
  /** Basis points of this node's time; qualified swarms sum to 10,000 (SPEC 7.1). */
  share_bp: z.number().int().min(0).max(10_000),
  release_id: z.uuid(),
  manifest_hash: digestSchema,
  permissions_hash: digestSchema,
  harness: z.object({ name: z.string(), version: semverSchema, hash: digestSchema }),
  joined_at: isoDate,
  qualification: qualificationProgressSchema.nullable(),
  /** Tasks waiting at the hosted coordinator, so the node's scheduler knows where work is (M5). */
  queue: z.object({ queued: z.number().int().nonnegative(), urgent: z.number().int().nonnegative() }).nullable(),
});
export type MembershipView = z.infer<typeof membershipSchema>;

/** GET /v1/store/home?node_id= : joined swarms first, then featured and categories (SPEC 4.2). */
export const storeHomeSchema = z.object({
  joined: z.array(membershipSchema),
  featured: z.array(swarmSummarySchema).max(3),
  categories: z.array(z.object({ key: categorySchema, label: z.string(), listed: z.number().int().nonnegative() })),
  node: z.object({
    id: z.uuid(),
    qualified_swarms: z.number().int().nonnegative(),
    share_total_bp: z.number().int().min(0).max(10_000),
    /** The user moved a slider; a new join then asks before rebalancing (SPEC 7.1). */
    shares_customized: z.boolean(),
    open_leases: z.array(z.object({ id: z.uuid(), swarm: slugSchema, status: leaseStatusSchema, deadline_at: isoDate })),
  }),
});
export type StoreHome = z.infer<typeof storeHomeSchema>;

export const permissionsSchema = swarmSummarySchema.shape.permissions;

/** POST /v1/swarms/{id}/memberships */
export const joinStartSchema = z.object({ node_id: z.uuid(), manifest_hash: digestSchema }).strict();
export const joinStartedSchema = z.object({
  membership: membershipSchema,
  resumed: z.boolean(),
  /** Exactly what the user approves (SPEC 4.2 Join permissions). */
  permissions: permissionsSchema,
  permissions_hash: digestSchema,
  qualification: z.object({ tasks: z.number().int().positive(), pass: z.number().int().positive() }),
  models: z.array(z.object({ content_hash: digestSchema, display_name: z.string(), license_id: z.string() })).min(1),
});
export type JoinStarted = z.infer<typeof joinStartedSchema>;

/** POST /v1/memberships/{id}/permission-grants */
export const permissionGrantSchema = z.object({ permissions_hash: digestSchema }).strict();
export const permissionGrantedSchema = z.object({ membership: membershipSchema, granted_at: isoDate });

/** POST /v1/memberships/{id}/qualification/lease */
export const qualificationLeaseSchema = z.object({
  qualification: qualificationProgressSchema,
  task: z.object({ id: z.uuid(), input: z.record(z.string(), z.unknown()) }),
  deadline_at: isoDate,
});
export type QualificationLease = z.infer<typeof qualificationLeaseSchema>;

/** POST /v1/memberships/{id}/qualification/results */
export const qualificationResultSchema = z
  .object({
    task_id: z.uuid(),
    output: z.record(z.string(), z.unknown()),
    output_sha256: digestSchema,
    run: z
      .object({
        model_artifact_hash: digestSchema,
        harness_hash: digestSchema,
        screen: z.object({ verdict: z.enum(['allow', 'flag']), reasons: z.array(z.string().max(60)).max(20), screener: z.string().max(60) }),
      })
      .strict(),
  })
  .strict();
/** `correct` is null while a machine-checked answer (a Lean proof) waits for the swarm's verifier. */
export const qualificationScoredSchema = z.object({ correct: z.boolean().nullable(), qualification: qualificationProgressSchema, membership: membershipSchema });

/** DELETE /v1/memberships/{id} */
export const membershipLeftSchema = z.object({ id: z.uuid(), left_at: isoDate, abandoned_leases: z.number().int().nonnegative() });

/** POST /v1/admin/reviews/{id}: release review stub (SPEC 13.4). `id` is a swarm release in review. */
export const releaseReviewSchema = z
  .object({ outcome: z.enum(['approved', 'rejected', 'changes_requested']), checklist: z.record(z.string(), z.boolean()), rationale: z.string().min(1).max(4000) })
  .strict();
export const releaseReviewedSchema = z.object({ release_id: z.uuid(), review_status: z.enum(['approved', 'rejected', 'draft']), reconsent_required: z.number().int(), moved: z.number().int() });

/* ----------------------------------------------------------------------------
 * Verification (SPEC 8, 13.3), M6
 * ------------------------------------------------------------------------- */

export const verificationSubjectSchema = z.object({ type: z.enum(['result', 'qualification_attempt']), id: z.uuid() }).strict();

/** GET /v1/verifier/work: results and qualification answers waiting for a machine check. Verifier-signed. */
export const verifierWorkItemSchema = z.object({
  subject: verificationSubjectSchema,
  swarm: z.string(),
  release_id: z.uuid(),
  harness: z.string(),
  checker: z.enum(['lean', 'prompt-guard-reproduction']).nullable(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  output_sha256: digestSchema,
});
export type VerifierWorkItem = z.infer<typeof verifierWorkItemSchema>;
export const verifierWorkSchema = z.object({ items: z.array(verifierWorkItemSchema) });

/** The signed record payload (SPEC 8.2); the signature covers its canonical JSON. */
export const verificationPayloadSchema = z
  .object({
    subject_type: z.enum(['result', 'qualification_attempt']),
    subject_id: z.uuid(),
    method: verificationMethodSchema,
    verifier_version: z.string().min(1).max(120),
    evidence_hashes: z.array(digestSchema).max(16),
    result_hash: digestSchema,
    outcome: z.enum(['accepted', 'rejected']),
    rationale_code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    panel: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

/** POST /v1/verifications: a signed verifier submission. `signature` is `keyId:base64url`. */
export const verificationSubmitSchema = z.object({ payload: verificationPayloadSchema, signature: z.string().min(10).max(300) }).strict();
export const verificationRecordedSchema = z.object({
  subject: verificationSubjectSchema,
  /** The result's lease state after this verdict, or the qualification answer's check status. */
  status: z.string().nullable(),
  duplicate: z.boolean(),
});

/* ----------------------------------------------------------------------------
 * Wallet, ledger and results (SPEC 9, 13.4), M6
 * ------------------------------------------------------------------------- */

/** GET /v1/wallet. Credits come only from funded swarms; impact is separate and nonspendable. */
export const walletSchema = z.object({
  credits: z.object({ settled: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), reserved: z.number().int().nonnegative() }),
  impact: z.object({ settled: z.number().int().nonnegative(), pending: z.number().int().nonnegative() }),
  /** False until the account has a result in a funded swarm; clients then show impact only. */
  has_funded_work: z.boolean(),
});
export type Wallet = z.infer<typeof walletSchema>;

/** GET /v1/ledger: the caller's own ledger rows. */
export const ledgerListSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      txn_id: z.uuid(),
      movement_type: z.enum(['purchase', 'donation', 'lease_reserve', 'reserve_release', 'accept_pending', 'settle', 'clawback', 'job_reserve', 'refund', 'correction']),
      bucket: z.enum(['available', 'reserved', 'pending', 'settled', 'issued']),
      debit: z.number().int().nonnegative(),
      credit: z.number().int().nonnegative(),
      reference_type: z.string(),
      reference_id: z.string(),
      created_at: isoDate,
    }),
  ),
});

export const resultStateSchema = z.enum(['submitted', 'verifying', 'pending', 'settled', 'rejected', 'clawed_back', 'not_counted']);
export type ResultState = z.infer<typeof resultStateSchema>;

/** GET /v1/me/results: each submitted result's real state, impact and credits (added M6, 2026-11-25). */
export const resultItemSchema = z.object({
  result_id: z.uuid(),
  lease_id: z.uuid(),
  swarm: z.string(),
  swarm_name: z.string(),
  funded: z.boolean(),
  state: resultStateSchema,
  disposition: z.enum(['on_time', 'late', 'after_abandon']),
  timeline: z.array(z.object({ state: resultStateSchema.exclude(['not_counted']), at: isoDate })),
  impact: z.object({ units: z.number().int().nonnegative(), status: z.enum(['pending', 'settled', 'revoked']) }).nullable(),
  credits: z.object({ amount: z.number().int().positive(), status: z.enum(['pending', 'settled', 'clawed_back']) }).nullable(),
  submitted_at: isoDate,
});
export type ResultItem = z.infer<typeof resultItemSchema>;
export const resultListSchema = z.object({ items: z.array(resultItemSchema) });

/** POST /v1/admin/results/{id}/clawback: fraud found while pending (added M6, 2026-11-25). */
export const clawbackSchema = z.object({ reason: z.string().min(3).max(500) }).strict();
export const clawedBackSchema = z.object({ result_id: z.uuid(), status: z.literal('clawed_back'), duplicate: z.boolean() });

