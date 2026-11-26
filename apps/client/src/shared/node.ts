/**
 * Node shell types shared by the main process, the supervisor process and the renderer.
 * Messages between main and the supervisor are validated with these schemas on receipt.
 */
import { fitStatusSchema, hardwareReportSchema, runtimeSchema, type Enforcement, type EnforcementSupport, type GateDecision, type HardwareReport, type Mode, type Recommendation, type RunRules, type RuntimeInfo, type ShareReport } from '@swarm-explorer/node-core';
import type { JoinStarted, StoreHome } from '@swarm-explorer/api-client';
import { z } from 'zod';

export const detectionSchema = z.object({
  hardware: hardwareReportSchema,
  runtimes: z.array(runtimeSchema).max(4),
  /** Set when an unpackaged test run used a fixture instead of probing (never in packaged builds). */
  fixture: z.string().max(60).nullable(),
  detectedAt: z.number().int(),
});
export type Detection = z.infer<typeof detectionSchema>;

const digest = z.string().regex(/^sha256-[a-f0-9]{64}$/);
const runtime = z.enum(['ollama', 'llama_cpp']);

/** What the supervisor reports after an install attempt. Mirrors node-core InstallOutcome. */
export const installOutcomeSchema = z.union([
  z.object({ ok: z.literal(true), verifiedHash: digest, managed: z.boolean(), location: z.string().max(1024) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['hash_mismatch', 'tag_drift', 'too_large', 'runtime_unavailable', 'download_failed', 'bad_reference', 'cancelled']),
    expected: z.string().max(80).optional(),
    actual: z.string().max(80).nullable().optional(),
    detail: z.string().max(300),
  }),
]);
export type InstallOutcomeMsg = z.infer<typeof installOutcomeSchema>;

/** Supervisor -> main. */
export const supervisorMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detected'), id: z.number().int(), detection: detectionSchema }),
  z.object({ type: z.literal('paused'), paused: z.boolean() }),
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('progress'), id: z.number().int(), completed: z.number().nonnegative(), total: z.number().nonnegative().nullable() }),
  z.object({ type: z.literal('installed'), id: z.number().int(), outcome: installOutcomeSchema }),
  z.object({ type: z.literal('benchmarked'), id: z.number().int(), tps: z.number().positive().nullable(), detail: z.string().max(300).nullable() }),
  z.object({ type: z.literal('removed'), id: z.number().int(), ok: z.boolean() }),
  z.object({ type: z.literal('harness-ran'), id: z.number().int(), result: z.lazy(() => harnessRunResultSchema) }),
  z.object({ type: z.literal('sandbox-checked'), id: z.number().int(), results: z.array(z.object({ id: z.string().max(60), title: z.string().max(200), passed: z.boolean(), detail: z.string().max(400) })).max(40) }),
]);

export type SandboxCheck = { id: string; title: string; passed: boolean; detail: string };
export type SupervisorMessage = z.infer<typeof supervisorMessageSchema>;

export type ArtifactRef = { contentHash: string; runtime: 'ollama' | 'llama_cpp'; sourceRef: string; sizeBytes: number };

/** Main -> supervisor. Main checks catalog, license, disk budget and fit before sending install. */
export type SupervisorCommand =
  | { type: 'detect'; id: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'install'; id: number; artifact: ArtifactRef }
  | { type: 'cancel'; id: number }
  | { type: 'benchmark'; id: number; runtime: 'ollama' | 'llama_cpp'; location: string }
  | { type: 'remove'; id: number; runtime: 'ollama' | 'llama_cpp'; location: string }
  /** Session capability key and proxy socket (SPEC 11.2). Sent by message, never by environment. */
  | { type: 'sandbox-config'; key: string; socketPath: string }
  | { type: 'sandbox-check'; id: number; activeModel: { contentHash: string; modelClass: string } | null }
  /** Verify the bundle, then run one task in the sandbox through the proxy (SPEC 11.3). */
  | { type: 'harness-run'; id: number; run: HarnessRunSpec }
  | { type: 'harness-cancel'; id: number };

/** Everything the supervisor needs for one sandboxed run. Main builds it from reviewed API facts. */
export type HarnessRunSpec = {
  bundleDir: string;
  release: { publisher: string; name: string; version: string; bundleHash: string; signature: string; reviewed: boolean; revoked: boolean };
  key: { keyId: string; publisher: string; publicKey: string; status: 'active' | 'revoked' };
  revoked: { harnessReleases: string[]; publisherKeys: string[] };
  swarm: string;
  /** What the user approved. Network and scratch are linked only when granted. */
  permissions: { network: string[]; scratchBytes: number };
  permissionsHash: string;
  model: { contentHash: string; modelClass: string };
  /** Capability scope label, for example `qualification:<membership id>`. */
  lease: string;
  timeoutS: number;
  input: Record<string, unknown>;
};

export const harnessRunResultSchema = z.object({
  status: z.enum(['ok', 'refused', 'limit_exceeded', 'failed', 'invalid_output', 'bundle_rejected', 'cancelled']),
  output: z.record(z.string(), z.unknown()).nullable(),
  detail: z.string().max(400),
  screen: z.object({ verdict: z.enum(['allow', 'flag']), reasons: z.array(z.string().max(60)).max(20), screener: z.string().max(60) }).nullable(),
  modelCalls: z.number().int().nonnegative(),
  /** Token counts the proxy reported across the run's model calls, when it reported them. */
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).optional(),
});
export type HarnessRunResult = z.infer<typeof harnessRunResultSchema>;

const fitSchema = z.object({ status: fitStatusSchema, basis: z.enum(['estimate', 'benchmark']), reason: z.string().max(40) });

/** A verified model on this computer (kept in the encrypted cache). */
export const installedModelSchema = z.object({
  contentHash: digest,
  slug: z.string().max(80),
  displayName: z.string().max(120),
  runtime,
  sourceRef: z.string().max(300),
  sizeBytes: z.number().int().positive(),
  location: z.string().max(1024),
  /** True when Henge downloaded it. Models the user already had are never removed by us. */
  managed: z.boolean(),
  installedAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
  verifiedHash: digest,
  benchmarkTps: z.number().nullable(),
  benchmarkDetail: z.string().max(300).nullable(),
  fit: fitSchema,
  benchmarkSharedAt: z.number().int().nullable(),
});
export type InstalledModel = z.infer<typeof installedModelSchema>;

export const blockedModelSchema = z.object({
  contentHash: digest,
  slug: z.string().max(80),
  reason: z.string().max(40),
  detail: z.string().max(300),
  expected: z.string().max(80).nullable(),
  actual: z.string().max(80).nullable(),
  at: z.number().int(),
});
export type BlockedModel = z.infer<typeof blockedModelSchema>;

export const storageSchema = z.object({
  diskBudgetBytes: z.number().int().positive().nullable(),
  activeModel: digest.nullable(),
});
export type Storage = z.infer<typeof storageSchema>;

export type ModelJob = { contentHash: string; slug: string; phase: 'downloading' | 'verifying' | 'benchmarking'; completed: number; total: number | null };

export const modelInstallInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/),
  contentHash: digest,
  /** The user ticked the license box in the confirmation dialog. */
  acceptLicense: z.literal(true),
  /** Set when this is the first download and the budget is chosen in the same dialog. */
  diskBudgetBytes: z.number().int().positive().optional(),
});
export type ModelInstallInput = z.infer<typeof modelInstallInputSchema>;

export type ModelActionResult = { ok: true } | { ok: false; code: string; message: string; suggestions?: string[] };

export type ModelsOverview = {
  installed: InstalledModel[];
  blocked: BlockedModel[];
  job: ModelJob | null;
  storage: Storage;
  usedBytes: number;
  /** Hashes that may never be offered for removal: the active model and the model of a running lease. */
  protected: string[];
  acceptedLicenses: string[];
};

export const nodeSetupSchema = z.object({
  mode: z.enum(['local', 'api', 'hybrid']),
  category: z.string().max(40),
  swarm: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/),
  completedAt: z.number().int(),
});
export type NodeSetup = z.infer<typeof nodeSetupSchema>;
export const nodeSetupInputSchema = nodeSetupSchema.omit({ completedAt: true });

export type RunRuleLine = { rule: string; value: string; enforcement: Enforcement; note: string };

/** A leased task on this node (SPEC 7.3), as the status bar and Library show it. */
export type TaskRunView = {
  leaseId: string;
  taskId: string;
  swarm: string;
  urgent: boolean;
  phase: 'starting' | 'running' | 'submitting';
  model: string;
  startedAt: number;
  deadlineAt: string;
};

export type TaskHistoryItem = {
  leaseId: string;
  swarm: string;
  /** submitted: on time, waiting for verification (M6). abandoned: unpaid, back in the queue. */
  outcome: 'submitted' | 'late' | 'abandoned' | 'failed';
  detail: string;
  elapsedMs: number;
  at: number;
};

export type TasksOverview = {
  /** off: signed out or no qualified swarm. waiting: rules allow, no work. blocked: a run rule holds work back. */
  phase: 'off' | 'paused' | 'blocked' | 'waiting' | 'leasing' | 'running';
  detail: string;
  current: TaskRunView | null;
  history: TaskHistoryItem[];
  gate: GateDecision | null;
  /** Per-swarm time this session, including urgent time charged ahead of a share (SPEC 7.1). */
  shares: ShareReport[];
};

/** Everything the first run and Settings > Node show. Contains no secrets. */
export type NodeOverview = {
  detection: Detection | null;
  recommendation: Recommendation | null;
  runRules: RunRuleLine[];
  /** The rules as set, and what this computer can enforce (SPEC 7.2 capability map). */
  rules: RunRules;
  support: EnforcementSupport;
  setup: NodeSetup | null;
  paused: boolean;
  /** Server-side registration (SPEC 13.1), when signed in. */
  registration: { nodeId: string; capabilitiesReportedAt: number | null } | null;
  /** Smallest catalog artifact used for the GPU check, or null when the catalog was offline. */
  catalogMinBytes: number | null;
  models: ModelsOverview;
  memberships: MembershipsOverview;
  tasks: TasksOverview;
};

/** A local join or qualification in progress, for the Library and join screens. */
export type MembershipJob = {
  membershipId: string;
  swarm: string;
  phase: 'downloading' | 'verifying' | 'running' | 'submitting' | 'done' | 'stopped' | 'error';
  detail: string;
};

export type Permissions = JoinStarted['permissions'];
export type MembershipResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };

/** Your swarms as the Library and Store show them. Contains no secrets. */
export type MembershipsOverview = {
  home: StoreHome | null;
  jobs: MembershipJob[];
  /** Permissions last approved per membership, for showing what a new release changes. */
  granted: Record<string, Permissions>;
  /** Swarms that joined at 0% beside customized shares; the Library asks whether to equalize (SPEC 7.1). */
  askEqualize: string[];
  error: string | null;
};

export type { HardwareReport, Mode, RuntimeInfo };
