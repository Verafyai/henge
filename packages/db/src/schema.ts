/**
 * Swarm Explorer data model (SPEC 12). IDs are UUIDv7 unless content-addressed;
 * timestamps are UTC; credit amounts are integers. Provider keys and anything that
 * could identify a key across users never reach this database (SPEC 12.1).
 *
 * Tables are grouped as in SPEC 12.1 to 12.5, followed by auth support tables
 * (SPEC 4.4) and the transactional outbox (SPEC 13.5).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from './uuid';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const credits = (name: string) => bigint(name, { mode: 'number' });
const micros = (name: string) => bigint(name, { mode: 'number' });

/* ----------------------------------------------------------------------------
 * Enums
 * ------------------------------------------------------------------------- */

export const swarmCategory = pgEnum('swarm_category', ['governance', 'mathematics', 'security', 'science', 'healthcare', 'public_goods', 'gaming']);
export const profileVisibility = pgEnum('profile_visibility', ['private', 'public']);
export const platformRole = pgEnum('platform_role', ['none', 'reviewer', 'admin']);
export const nodeMode = pgEnum('node_mode', ['local', 'api', 'hybrid']);
export const nodeStatus = pgEnum('node_status', ['setup', 'ready', 'paused', 'offline', 'blocked']);
export const sourceKind = pgEnum('source_kind', ['ollama', 'llama_cpp', 'openrouter', 'anthropic', 'openai', 'xai']);
export const sourceStatus = pgEnum('source_status', ['available', 'unavailable', 'disabled_by_policy', 'key_failed']);
export const reviewStatus = pgEnum('review_status', ['draft', 'in_review', 'approved', 'rejected', 'revoked']);
export const badgeStatus = pgEnum('badge_status', ['none', 'pending', 'verified', 'revoked']);
export const publisherStatus = pgEnum('publisher_status', ['active', 'suspended']);
export const keyStatus = pgEnum('key_status', ['active', 'revoked']);
export const modelSource = pgEnum('model_source', ['ollama', 'huggingface']);
export const fitStatus = pgEnum('fit_status', ['runs_well', 'runs_slowly', 'will_not_fit', 'unknown']);
export const harnessRuntime = pgEnum('harness_runtime', ['wasm', 'container']);
export const swarmVisibility = pgEnum('swarm_visibility', ['public', 'private']);
export const fundedMode = pgEnum('funded_mode', ['volunteer', 'funded']);
export const swarmStatus = pgEnum('swarm_status', ['draft', 'in_review', 'listed', 'publisher_paused', 'halted', 'retired']);
export const featuredStatus = pgEnum('featured_status', ['none', 'featured', 'removed_pending_review']);
export const reviewTarget = pgEnum('review_target', ['swarm_release', 'harness_release', 'model', 'publisher']);
export const reviewOutcome = pgEnum('review_outcome', ['approved', 'rejected', 'changes_requested']);
export const reportStatus = pgEnum('report_status', ['open', 'reviewing', 'actioned', 'dismissed']);
export const revocationTarget = pgEnum('revocation_target', ['swarm', 'swarm_release', 'harness_release', 'model_artifact', 'publisher_key', 'client_version']);
export const severity = pgEnum('severity', ['low', 'high', 'critical']);
export const membershipStatus = pgEnum('membership_status', ['joining', 'qualifying', 'active', 'paused', 'reconsent_required', 'left']);
export const qualificationOutcome = pgEnum('qualification_outcome', ['in_progress', 'passed', 'failed']);
export const taskStatus = pgEnum('task_status', ['queued', 'leased', 'completed', 'cancelled']);
export const leaseStatus = pgEnum('lease_status', [
  'leased', 'running', 'submitted', 'verifying', 'pending', 'settled', 'rejected', 'abandoned', 'expired', 'clawed_back',
]);
export const verificationMethod = pgEnum('verification_method', ['machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review']);
export const verificationOutcome = pgEnum('verification_outcome', ['accepted', 'rejected']);
export const creditOwnerType = pgEnum('credit_owner_type', ['account', 'publisher', 'pool', 'platform']);
export const accountStatus = pgEnum('account_status', ['active', 'frozen', 'closed']);
export const movementType = pgEnum('movement_type', [
  'purchase', 'donation', 'lease_reserve', 'reserve_release', 'accept_pending', 'settle', 'clawback', 'job_reserve', 'refund', 'correction',
]);
export const purchaseStatus = pgEnum('purchase_status', ['created', 'paid', 'failed', 'refunded']);
export const configStatus = pgEnum('config_status', ['proposal', 'approved', 'retired']);
export const teamVisibility = pgEnum('team_visibility', ['private', 'public']);
export const teamRole = pgEnum('team_role', ['owner', 'member']);
export const channel = pgEnum('release_channel', ['stable', 'beta', 'internal']);

/* ----------------------------------------------------------------------------
 * 12.1 Identity and nodes
 * ------------------------------------------------------------------------- */

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    /** SHA-256 of the normalized email; the address itself is held by the identity provider. */
    emailHash: text('email_hash'),
    profileVisibility: profileVisibility('profile_visibility').notNull().default('private'),
    reputationOverall: integer('reputation_overall').notNull().default(0),
    platformRole: platformRole('platform_role').notNull().default('none'),
    createdAt: createdAt(),
    suspendedAt: ts('suspended_at'),
  },
  (t) => [uniqueIndex('accounts_handle_idx').on(sql`lower(${t.handle})`)],
);

export const accountIdentities = pgTable(
  'account_identities',
  {
    id: id(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject').notNull(),
    verifiedAt: ts('verified_at'),
  },
  (t) => [uniqueIndex('account_identities_subject_idx').on(t.provider, t.providerSubject)],
);

/** Public OAuth clients (desktop app, CLI). PKCE is always required. */
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['desktop', 'cli'] }).notNull(),
  // Exact redirect URIs. Loopback entries match any port per RFC 8252 section 7.3.
  redirectUris: text('redirect_uris').array().notNull(),
  createdAt: createdAt(),
});

export const installs = pgTable(
  'installs',
  {
    id: id(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    clientId: text('client_id').notNull().references(() => oauthClients.id),
    platform: text('platform').notNull(),
    arch: text('arch').notNull(),
    clientVersion: text('client_version').notNull(),
    channel: text('channel', { enum: ['stable', 'beta', 'internal', 'dev'] }).notNull(),
    /** Ed25519 public key, SPKI DER, base64url. Node requests and refreshes are signed with the private half. */
    devicePublicKey: text('device_public_key').notNull(),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [index('installs_account_idx').on(t.accountId)],
);

export const nodes = pgTable(
  'nodes',
  {
    id: id(),
    installId: uuid('install_id').notNull().references(() => installs.id),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    name: text('name').notNull(),
    mode: nodeMode('mode').notNull().default('local'),
    status: nodeStatus('status').notNull().default('setup'),
    runRulesJson: jsonb('run_rules_json').notNull(),
    /** Chosen by the user at the first model download (SPEC 5.4, M2); unset until then. */
    diskBudgetBytes: bigint('disk_budget_bytes', { mode: 'number' }),
    concurrencyLocal: smallint('concurrency_local').notNull().default(1),
    concurrencyApi: smallint('concurrency_api').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('nodes_install_idx').on(t.installId),
    check('nodes_concurrency_check', sql`${t.concurrencyLocal} >= 0 and ${t.concurrencyApi} >= 0`),
  ],
);

/** Minimized hardware report (SPEC 5.1). Unknown values are allowed and stay null. */
export const nodeCapabilities = pgTable(
  'node_capabilities',
  {
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    observedAt: ts('observed_at').notNull().defaultNow(),
    os: text('os').notNull(),
    cpuClass: text('cpu_class'),
    ramBytes: bigint('ram_bytes', { mode: 'number' }),
    gpuFamily: text('gpu_family'),
    vramBytes: bigint('vram_bytes', { mode: 'number' }),
    freeDiskBytes: bigint('free_disk_bytes', { mode: 'number' }),
    enforcementSupportJson: jsonb('enforcement_support_json').notNull(),
    confidence: text('confidence', { enum: ['measured', 'estimated', 'unknown'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.observedAt] })],
);

export const computeSources = pgTable('compute_sources', {
  id: id(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  kind: sourceKind('kind').notNull(),
  status: sourceStatus('status').notNull(),
  providerEnabledByPolicy: boolean('provider_enabled_by_policy').notNull().default(false),
  /**
   * An opaque random id the client maps to its keychain entry. Never a key, a key hash or
   * a fingerprint, so nothing here can be linked across users (SPEC 12.1).
   */
  localKeyRef: text('local_key_ref'),
  lastSuccessAt: ts('last_success_at'),
});

export const spendCaps = pgTable('spend_caps', {
  nodeId: uuid('node_id').primaryKey().references(() => nodes.id, { onDelete: 'cascade' }),
  dailyUsdMicros: micros('daily_usd_micros').notNull(),
  monthlyUsdMicros: micros('monthly_usd_micros').notNull(),
  perTaskUsdMicros: micros('per_task_usd_micros').notNull(),
  perSwarmJson: jsonb('per_swarm_json').notNull().default({}),
  version: integer('version').notNull().default(1),
});

/* ----------------------------------------------------------------------------
 * 12.2 Catalog, releases and trust
 * ------------------------------------------------------------------------- */

export const publishers = pgTable(
  'publishers',
  {
    id: id(),
    /** The manifest `publisher` value, for example "verafy.ai". */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id),
    verifiedDomain: text('verified_domain'),
    verifiedGithubOrg: text('verified_github_org'),
    badgeStatus: badgeStatus('badge_status').notNull().default('none'),
    status: publisherStatus('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('publishers_slug_idx').on(t.slug)],
);

export const publisherKeys = pgTable(
  'publisher_keys',
  {
    id: id(),
    publisherId: uuid('publisher_id').notNull().references(() => publishers.id),
    keyId: text('key_id').notNull(),
    /** SPKI DER, base64. */
    publicKey: text('public_key').notNull(),
    algorithm: text('algorithm', { enum: ['ed25519'] }).notNull().default('ed25519'),
    status: keyStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('publisher_keys_key_id_idx').on(t.keyId)],
);

export const models = pgTable(
  'models',
  {
    id: id(),
    slug: text('slug').notNull(),
    source: modelSource('source').notNull(),
    family: text('family').notNull(),
    displayName: text('display_name').notNull(),
    modelClass: text('model_class').notNull(),
    licenseId: text('license_id').notNull(),
    reviewStatus: reviewStatus('review_status').notNull().default('in_review'),
  },
  (t) => [uniqueIndex('models_slug_idx').on(t.slug)],
);

export const modelArtifacts = pgTable(
  'model_artifacts',
  {
    id: id(),
    modelId: uuid('model_id').notNull().references(() => models.id),
    versionLabel: text('version_label').notNull(),
    /** sha256-<hex>. Nodes verify this before first use and refuse mutable tag drift (SPEC 5.4). */
    contentHash: text('content_hash').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contextLength: integer('context_length').notNull(),
    quantization: text('quantization').notNull(),
    runtimeFormats: text('runtime_formats').array().notNull(),
    catalogVersion: integer('catalog_version').notNull(),
    /** Where the node fetches it: an Ollama tag, or `owner/repo@revision/file.gguf` on Hugging Face. */
    sourceRef: text('source_ref').notNull(),
  },
  (t) => [uniqueIndex('model_artifacts_hash_idx').on(t.contentHash)],
);

export const nodeModels = pgTable(
  'node_models',
  {
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    modelArtifactId: uuid('model_artifact_id').notNull().references(() => modelArtifacts.id),
    installedAt: ts('installed_at').notNull().defaultNow(),
    verifiedHash: text('verified_hash').notNull(),
    benchmarkTps: real('benchmark_tps'),
    fitStatus: fitStatus('fit_status').notNull().default('unknown'),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.modelArtifactId] })],
);

/**
 * Per-runtime speed thresholds for benchmark-backed fit, stored with a catalog version (SPEC 5.4).
 * Only approved rows are used. None ship approved: thresholds need real calibration data.
 */
export const fitCalibrations = pgTable(
  'fit_calibrations',
  {
    id: id(),
    runtime: text('runtime').notNull(),
    catalogVersion: integer('catalog_version').notNull(),
    runsWellMinTps: real('runs_well_min_tps').notNull(),
    runsSlowlyMinTps: real('runs_slowly_min_tps').notNull(),
    status: reviewStatus('status').notNull().default('draft'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('fit_calibrations_runtime_version_idx').on(t.runtime, t.catalogVersion)],
);

/** License acceptance per user and artifact version (SPEC 5.4). */
export const licenseAcceptances = pgTable(
  'license_acceptances',
  {
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    modelArtifactId: uuid('model_artifact_id').notNull().references(() => modelArtifacts.id),
    licenseId: text('license_id').notNull(),
    acceptedAt: ts('accepted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.modelArtifactId] })],
);

export const harnesses = pgTable(
  'harnesses',
  {
    id: id(),
    publisherId: uuid('publisher_id').notNull().references(() => publishers.id),
    name: text('name').notNull(),
    reviewStatus: reviewStatus('review_status').notNull().default('draft'),
  },
  (t) => [uniqueIndex('harnesses_publisher_name_idx').on(t.publisherId, t.name)],
);

export const harnessReleases = pgTable(
  'harness_releases',
  {
    id: id(),
    harnessId: uuid('harness_id').notNull().references(() => harnesses.id),
    version: text('version').notNull(),
    bundleHash: text('bundle_hash').notNull(),
    runtime: harnessRuntime('runtime').notNull(),
    minModelClass: text('min_model_class').notNull(),
    outputSchemaHash: text('output_schema_hash').notNull(),
    signature: text('signature').notNull(),
    sbomHash: text('sbom_hash').notNull(),
    reviewStatus: reviewStatus('review_status').notNull().default('in_review'),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('harness_releases_version_idx').on(t.harnessId, t.version), uniqueIndex('harness_releases_hash_idx').on(t.bundleHash)],
);

export const swarms = pgTable(
  'swarms',
  {
    id: id(),
    slug: text('slug').notNull(),
    publisherId: uuid('publisher_id').notNull().references(() => publishers.id),
    category: swarmCategory('category').notNull(),
    visibility: swarmVisibility('visibility').notNull().default('public'),
    fundedMode: fundedMode('funded_mode').notNull(),
    status: swarmStatus('status').notNull().default('draft'),
    featuredStatus: featuredStatus('featured_status').notNull().default('none'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('swarms_slug_idx').on(t.slug)],
);

export const swarmReleases = pgTable(
  'swarm_releases',
  {
    id: id(),
    swarmId: uuid('swarm_id').notNull().references(() => swarms.id),
    manifestVersion: smallint('manifest_version').notNull(),
    /** The signed manifest object (SPEC 6.4). Its canonical form minus signatures is what was signed. */
    manifestJson: jsonb('manifest_json').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    harnessReleaseId: uuid('harness_release_id').notNull().references(() => harnessReleases.id),
    coordinatorConfig: jsonb('coordinator_config').notNull(),
    signature: jsonb('signature').notNull(),
    /** Hash of the permission set, for exact reconsent matching (SPEC 13.2). */
    permissionsHash: text('permissions_hash').notNull(),
    reviewStatus: reviewStatus('review_status').notNull().default('in_review'),
    publishedAt: ts('published_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('swarm_releases_hash_idx').on(t.manifestHash), index('swarm_releases_swarm_idx').on(t.swarmId)],
);

export const reviews = pgTable('reviews', {
  id: id(),
  targetType: reviewTarget('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  reviewerId: uuid('reviewer_id').notNull().references(() => accounts.id),
  checklistJson: jsonb('checklist_json').notNull(),
  outcome: reviewOutcome('outcome').notNull(),
  rationale: text('rationale').notNull(),
  createdAt: createdAt(),
});

export const reports = pgTable('reports', {
  id: id(),
  swarmId: uuid('swarm_id').notNull().references(() => swarms.id),
  reporterAccountId: uuid('reporter_account_id').notNull().references(() => accounts.id),
  category: text('category').notNull(),
  detailsRedacted: text('details_redacted').notNull(),
  status: reportStatus('status').notNull().default('open'),
  createdAt: createdAt(),
});

/** Signed kill-switch and revocation feed entries (SPEC 11.6). */
export const revocations = pgTable(
  'revocations',
  {
    id: id(),
    targetType: revocationTarget('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason').notNull(),
    severity: severity('severity').notNull(),
    signedPayload: text('signed_payload').notNull(),
    effectiveAt: ts('effective_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('revocations_effective_idx').on(t.effectiveAt)],
);

/* ----------------------------------------------------------------------------
 * 12.3 Membership and work
 * ------------------------------------------------------------------------- */

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    nodeId: uuid('node_id').notNull().references(() => nodes.id),
    swarmId: uuid('swarm_id').notNull().references(() => swarms.id),
    releaseId: uuid('release_id').notNull().references(() => swarmReleases.id),
    status: membershipStatus('status').notNull().default('joining'),
    /** Basis points; a node's active shares sum to 10,000 (SPEC 7.1). */
    shareBp: integer('share_bp').notNull().default(0),
    joinedAt: createdAt(),
    leftAt: ts('left_at'),
  },
  (t) => [
    uniqueIndex('memberships_active_idx').on(t.nodeId, t.swarmId).where(sql`${t.leftAt} is null`),
    check('memberships_share_check', sql`${t.shareBp} between 0 and 10000`),
  ],
);

export const permissionGrants = pgTable('permission_grants', {
  id: id(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  releaseId: uuid('release_id').notNull().references(() => swarmReleases.id),
  permissionsHash: text('permissions_hash').notNull(),
  grantedJson: jsonb('granted_json').notNull(),
  grantedAt: createdAt(),
  revokedAt: ts('revoked_at'),
});

export const qualifications = pgTable('qualifications', {
  id: id(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  releaseId: uuid('release_id').notNull().references(() => swarmReleases.id),
  attempts: smallint('attempts').notNull().default(0),
  passed: smallint('passed').notNull().default(0),
  outcome: qualificationOutcome('outcome').notNull().default('in_progress'),
  completedAt: ts('completed_at'),
});

/**
 * Known-answer qualification tasks (SPEC 3.2, 4.2), held by the coordinator. `expected_json` names
 * the output fields a correct answer must match; it never leaves the server. Qualification is not
 * credited work: it creates no ledger entries.
 */
export const qualificationTasks = pgTable(
  'qualification_tasks',
  {
    id: id(),
    swarmId: uuid('swarm_id').notNull().references(() => swarms.id),
    inputJson: jsonb('input_json').notNull(),
    expectedJson: jsonb('expected_json').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('qualification_tasks_swarm_idx').on(t.swarmId)],
);

/** One leased qualification task within one qualification round. Each task is answered at most once per round. */
export const qualificationAttempts = pgTable(
  'qualification_attempts',
  {
    id: id(),
    qualificationId: uuid('qualification_id').notNull().references(() => qualifications.id),
    taskId: uuid('task_id').notNull().references(() => qualificationTasks.id),
    leasedAt: createdAt(),
    deadlineAt: ts('deadline_at').notNull(),
    submittedAt: ts('submitted_at'),
    outputHash: text('output_hash'),
    correct: boolean('correct'),
  },
  (t) => [uniqueIndex('qualification_attempts_task_idx').on(t.qualificationId, t.taskId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    swarmId: uuid('swarm_id').notNull().references(() => swarms.id),
    releaseId: uuid('release_id').notNull().references(() => swarmReleases.id),
    coordinatorTaskId: text('coordinator_task_id').notNull(),
    inputRef: text('input_ref').notNull(),
    inputHash: text('input_hash').notNull(),
    modelRequirementJson: jsonb('model_requirement_json').notNull(),
    urgent: boolean('urgent').notNull().default(false),
    /** Null for volunteer swarms, which pay impact only. */
    rewardCredits: credits('reward_credits'),
    status: taskStatus('status').notNull().default('queued'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('tasks_coordinator_idx').on(t.swarmId, t.coordinatorTaskId),
    check('tasks_reward_check', sql`${t.rewardCredits} is null or ${t.rewardCredits} > 0`),
  ],
);

export const leases = pgTable(
  'leases',
  {
    id: id(),
    taskId: uuid('task_id').notNull().references(() => tasks.id),
    nodeId: uuid('node_id').notNull().references(() => nodes.id),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    status: leaseStatus('status').notNull().default('leased'),
    leasedAt: createdAt(),
    deadlineAt: ts('deadline_at').notNull(),
    abandonedAt: ts('abandoned_at'),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (t) => [uniqueIndex('leases_idempotency_idx').on(t.nodeId, t.idempotencyKey), index('leases_task_idx').on(t.taskId)],
);

export const runRecords = pgTable('run_records', {
  id: id(),
  leaseId: uuid('lease_id').notNull().references(() => leases.id),
  modelIdClaim: text('model_id_claim').notNull(),
  modelArtifactHash: text('model_artifact_hash'),
  provider: text('provider'),
  harnessHash: text('harness_hash').notNull(),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  elapsedMs: integer('elapsed_ms').notNull(),
  costUsdMicrosReported: micros('cost_usd_micros_reported'),
  runRecordSignature: text('run_record_signature').notNull(),
});

export const results = pgTable(
  'results',
  {
    id: id(),
    leaseId: uuid('lease_id').notNull().references(() => leases.id),
    outputRef: text('output_ref').notNull(),
    outputHash: text('output_hash').notNull(),
    schemaValid: boolean('schema_valid').notNull(),
    submittedAt: createdAt(),
  },
  // Duplicate submissions are idempotent by lease and result hash (SPEC 7.3).
  (t) => [uniqueIndex('results_lease_hash_idx').on(t.leaseId, t.outputHash)],
);

export const verificationRecords = pgTable('verification_records', {
  id: id(),
  resultId: uuid('result_id').notNull().references(() => results.id),
  method: verificationMethod('method').notNull(),
  verifierVersion: text('verifier_version').notNull(),
  evidenceHashes: text('evidence_hashes').array().notNull(),
  outcome: verificationOutcome('outcome').notNull(),
  rationaleCode: text('rationale_code').notNull(),
  panelJson: jsonb('panel_json'),
  signature: text('signature').notNull(),
  pendingWindowEndsAt: ts('pending_window_ends_at'),
  createdAt: createdAt(),
});

export const reputationEvents = pgTable('reputation_events', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  nodeId: uuid('node_id').references(() => nodes.id),
  swarmId: uuid('swarm_id').references(() => swarms.id),
  eventType: text('event_type').notNull(),
  delta: integer('delta').notNull(),
  scoreVersion: text('score_version').notNull(),
  evidenceRef: text('evidence_ref').notNull(),
  createdAt: createdAt(),
});

export const impactEvents = pgTable(
  'impact_events',
  {
    id: id(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    nodeId: uuid('node_id').notNull().references(() => nodes.id),
    swarmId: uuid('swarm_id').notNull().references(() => swarms.id),
    category: swarmCategory('category').notNull(),
    units: integer('units').notNull(),
    resultId: uuid('result_id').notNull().references(() => results.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('impact_events_result_idx').on(t.resultId), check('impact_units_check', sql`${t.units} >= 0`)],
);

/* ----------------------------------------------------------------------------
 * 12.4 Ledger and pools
 * ------------------------------------------------------------------------- */

export const creditAccounts = pgTable(
  'credit_accounts',
  {
    id: id(),
    ownerType: creditOwnerType('owner_type').notNull(),
    ownerId: uuid('owner_id'),
    currency: text('currency', { enum: ['credit'] }).notNull().default('credit'),
    status: accountStatus('status').notNull().default('active'),
  },
  (t) => [uniqueIndex('credit_accounts_owner_idx').on(t.ownerType, t.ownerId)],
);

export const pools = pgTable(
  'pools',
  {
    id: id(),
    /** The manifest `credits.pool_id`. */
    slug: text('slug').notNull(),
    swarmId: uuid('swarm_id').notNull().references(() => swarms.id),
    publisherId: uuid('publisher_id').notNull().references(() => publishers.id),
    creditAccountId: uuid('credit_account_id').notNull().references(() => creditAccounts.id),
    fundedMode: fundedMode('funded_mode').notNull(),
    /** Caches rebuilt from ledger entries; never written outside a ledger transaction (SPEC 9.5). */
    availableCached: credits('available_cached').notNull().default(0),
    reservedCached: credits('reserved_cached').notNull().default(0),
  },
  (t) => [
    uniqueIndex('pools_slug_idx').on(t.slug),
    check('pools_nonnegative', sql`${t.availableCached} >= 0 and ${t.reservedCached} >= 0`),
  ],
);

/**
 * Append-only double-entry ledger (SPEC 9.5). Each row moves a positive integer amount on
 * exactly one side. A database trigger (migration 0001) refuses UPDATE and DELETE; corrections
 * are new reversing entries.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    txnId: uuid('txn_id').notNull(),
    creditAccountId: uuid('credit_account_id').notNull().references(() => creditAccounts.id),
    debitCredits: credits('debit_credits').notNull().default(0),
    creditCredits: credits('credit_credits').notNull().default(0),
    movementType: movementType('movement_type').notNull(),
    referenceType: text('reference_type').notNull(),
    referenceId: text('reference_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_account_idx').on(t.creditAccountId),
    index('ledger_entries_txn_idx').on(t.txnId),
    uniqueIndex('ledger_entries_idempotency_idx').on(t.idempotencyKey, t.creditAccountId),
    check('ledger_one_side', sql`(${t.debitCredits} > 0 and ${t.creditCredits} = 0) or (${t.creditCredits} > 0 and ${t.debitCredits} = 0)`),
  ],
);

export const creditPurchases = pgTable('credit_purchases', {
  id: id(),
  publisherId: uuid('publisher_id').notNull().references(() => publishers.id),
  processorRef: text('processor_ref'),
  amountCurrencyMinor: bigint('amount_currency_minor', { mode: 'number' }).notNull(),
  creditsIssued: credits('credits_issued').notNull(),
  priceConfigVersion: uuid('price_config_version').notNull(),
  takeRateConfigVersion: uuid('take_rate_config_version').notNull(),
  status: purchaseStatus('status').notNull().default('created'),
  createdAt: createdAt(),
});

/**
 * Pricing is a proposal until Rex approves it (SPEC 9.6). Money amounts are integer
 * minor units; the take rate is integer basis points.
 */
export const economicConfigs = pgTable('economic_configs', {
  id: id(),
  creditPriceMinor: integer('credit_price_minor').notNull(),
  currency: text('currency').notNull().default('USD'),
  takeRateBp: integer('take_rate_bp').notNull(),
  hostedFreeTaskVolume: integer('hosted_free_task_volume'),
  privateSeatPriceMinor: integer('private_seat_price_minor'),
  status: configStatus('status').notNull().default('proposal'),
  approvedBy: uuid('approved_by').references(() => accounts.id),
  effectiveAt: ts('effective_at'),
  notes: text('notes').notNull().default(''),
  createdAt: createdAt(),
});

/* ----------------------------------------------------------------------------
 * 12.5 Social, teams and notifications
 * ------------------------------------------------------------------------- */

export const badges = pgTable('badges', {
  id: id(),
  category: swarmCategory('category'),
  criterionVersion: text('criterion_version').notNull(),
  displayName: text('display_name').notNull(),
});

export const accountBadges = pgTable(
  'account_badges',
  {
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    badgeId: uuid('badge_id').notNull().references(() => badges.id),
    awardedForResultId: uuid('awarded_for_result_id').notNull().references(() => results.id),
    awardedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.badgeId] })],
);

export const teams = pgTable('teams', {
  id: id(),
  name: text('name').notNull(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id),
  visibility: teamVisibility('visibility').notNull().default('private'),
  createdAt: createdAt(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id').notNull().references(() => teams.id),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    role: teamRole('role').notNull().default('member'),
    consentImpactRollup: boolean('consent_impact_rollup').notNull().default(false),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.accountId] })],
);

export const shareCards = pgTable('share_cards', {
  id: id(),
  resultId: uuid('result_id').notNull().references(() => results.id),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  visibility: profileVisibility('visibility').notNull().default('private'),
  renderedImageRef: text('rendered_image_ref'),
  createdAt: createdAt(),
});

export const notificationPrefs = pgTable('notification_prefs', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id),
  weeklySummary: boolean('weekly_summary').notNull().default(false),
  channelsJson: jsonb('channels_json').notNull().default({}),
});

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_account_idx').on(t.accountId, t.createdAt)],
);

/* ----------------------------------------------------------------------------
 * Auth support (SPEC 4.4). Tokens are opaque; only SHA-256 hashes are stored.
 * ------------------------------------------------------------------------- */

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.id),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    installId: uuid('install_id').notNull().references(() => installs.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    parentId: uuid('parent_id'),
    createdAt: createdAt(),
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('refresh_tokens_hash_idx').on(t.tokenHash)],
);

export const accessTokens = pgTable(
  'access_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    installId: uuid('install_id').notNull().references(() => installs.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('access_tokens_install_idx').on(t.installId)],
);

/** Web sessions, used only for the client handoff and account essentials. */
export const webSessions = pgTable('web_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
});

/** Write idempotency (SPEC 13): the first response to a key is replayed for repeats with the same request. */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    key: text('key').notNull(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: smallint('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] })],
);

/**
 * Replay protection for device-signed node requests (SPEC 13). A nonce is accepted once per
 * install; rows older than the signature skew window can be pruned.
 */
export const deviceNonces = pgTable(
  'device_nonces',
  {
    installId: uuid('install_id').notNull().references(() => installs.id, { onDelete: 'cascade' }),
    nonce: text('nonce').notNull(),
    seenAt: ts('seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.installId, t.nonce] }), index('device_nonces_seen_idx').on(t.seenAt)],
);

/** Desktop client update manifests (SPEC 15.1), signed with the release key. */
export const clientReleases = pgTable(
  'client_releases',
  {
    id: id(),
    version: text('version').notNull(),
    channel: channel('channel').notNull(),
    platform: text('platform').notNull(),
    arch: text('arch').notNull(),
    url: text('url').notNull(),
    sha256: text('sha256').notNull(),
    /** The exact signed manifest bytes and its ed25519 signature, base64url. */
    manifest: text('manifest').notNull(),
    signature: text('signature').notNull(),
    notesMd: text('notes_md').notNull().default(''),
    publishedAt: ts('published_at').notNull().defaultNow(),
    rolloutPct: smallint('rollout_pct').notNull().default(100),
    yankedAt: ts('yanked_at'),
  },
  (t) => [uniqueIndex('client_releases_identity_idx').on(t.version, t.channel, t.platform, t.arch)],
);

/** Transactional outbox (SPEC 13.5): events commit with the change that caused them. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
    processedAt: ts('processed_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [index('outbox_unprocessed_idx').on(t.createdAt).where(sql`${t.processedAt} is null`)],
);

export type Account = typeof accounts.$inferSelect;
export type Install = typeof installs.$inferSelect;
export type Publisher = typeof publishers.$inferSelect;
export type Swarm = typeof swarms.$inferSelect;
export type SwarmRelease = typeof swarmReleases.$inferSelect;
export type Model = typeof models.$inferSelect;
export type ModelArtifact = typeof modelArtifacts.$inferSelect;
export type HarnessRelease = typeof harnessReleases.$inferSelect;
export type ClientRelease = typeof clientReleases.$inferSelect;
export type Pool = typeof pools.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
