/**
 * Types shared by the workflow code (bundled on its own, deterministic, no Node APIs) and the
 * activities that run in the main process. Only types live here, so importing this file from
 * workflow code adds nothing to the workflow bundle.
 */

export type AbandonReasonT = 'paused' | 'left' | 'run_rules' | 'local_failure' | 'signed_out' | 'pin_mismatch' | 'kill_switch';

export type SwarmTaskInput = {
  nodeId: string;
  membershipId: string;
  swarm: string;
  permissionsHash: string;
  harnessHash: string;
  model: { contentHash: string; slug: string; displayName: string };
  /** The swarm's task timeout, so the run step's time limit follows it. */
  timeoutS: number;
};

export type LeaseSummary = {
  leaseId: string;
  taskId: string;
  swarm: string;
  urgent: boolean;
  harnessHash: string;
  permissionsHash: string;
  inputSha256: string;
  leasedAt: number;
  deadlineAt: string;
};

export type LeaseStep = { kind: 'lease'; lease: LeaseSummary } | { kind: 'none'; code: string; message: string; kill: boolean };

export type StartStep = { ok: true; input: Record<string, unknown>; deadlineAt: string } | { ok: false; code: string; message: string; kill: boolean; abandon: boolean };

export type GuardStep = { ok: true } | { ok: false; reason: AbandonReasonT; detail: string };

export type RunStep =
  | { status: 'ok'; output: Record<string, unknown>; tokens: { input: number | null; output: number | null }; fuel: { meter: 'meter/1'; used: number; budget: number | null } | null; elapsedMs: number }
  | { status: 'failed'; detail: string }
  | { status: 'stopped'; reason: AbandonReasonT; detail: string }
  | { status: 'expired'; detail: string };

/** The exact request body sent to the results endpoint. Journaled, so a retry repeats it byte for byte. */
export type SealedResult = { body: { output: Record<string, unknown>; output_sha256: string; run_record: Record<string, unknown> }; outputSha256: string };

export type SubmitStep = { ok: true; disposition: 'on_time' | 'late' | 'after_abandon'; duplicate: boolean; replayed: boolean; resultId: string } | { ok: false; code: string; message: string };

export type TaskOutcome = {
  outcome: 'no_task' | 'submitted' | 'late' | 'abandoned' | 'failed';
  detail: string;
  leaseId: string | null;
  code?: string;
  kill?: boolean;
  duplicate?: boolean;
};

/** Where a task workflow is, for the Activity view and for recovery. */
export type TaskProgress = { leaseId: string | null; phase: 'leasing' | 'starting' | 'running' | 'submitting' | 'done'; deadlineAt: string | null; urgent: boolean };

/* Henge bundles (6.5 step 5, 6.4). */

export type HengePinRecord = {
  id: string;
  url: string;
  commit: string | null;
  etag: string | null;
  bundleDigest: string;
  version: string;
  name: string;
  admissionMode: string;
  reconsentOn: string[];
  /** The member's own daily cap for this Henge, in USD micros. */
  dailyCapUsdMicros: number | null;
  joinedAt: number;
  status: 'joined' | 'awaiting_admission' | 'awaiting_reconsent';
  /** An update waiting for the member to re-confirm, when one changed a `member_reconsent_on` field. */
  pending: { version: string; bundleDigest: string; etag: string | null; commit: string | null; fields: string[] } | null;
};

export type JoinInput = { url: string; dailyCapUsdMicros: number | null };
export type JoinResolveStep = { ok: true; pin: HengePinRecord; bundleWorkflowId: string } | { ok: false; issues: Array<{ code: string; message: string }> };
export type JoinOutcome = { ok: true; id: string; status: HengePinRecord['status'] } | { ok: false; issues: Array<{ code: string; message: string }> };

export type BundleUpdateState = { hengeId: string; checks: number };
export type BundleCheckStep =
  | { kind: 'unchanged' }
  | { kind: 'gone' }
  | { kind: 'error'; message: string }
  | { kind: 'update'; version: string; bundleDigest: string; etag: string | null; commit: string | null; reconsent: string[]; issues: string[] };
