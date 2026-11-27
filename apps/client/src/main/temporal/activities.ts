/**
 * Activities for the node workflows (workflows.ts). They run in the Electron main process, which
 * holds the device key and talks to the coordinator, and reach the sandbox through the supervisor
 * exactly as the M5 runner did. Every step that writes to the coordinator sends an Idempotency-Key
 * derived from a durable id (the workflow id or the lease id), so a step retried after a kill
 * repeats the same request and the coordinator replays its first answer.
 */
import { createHash } from 'node:crypto';
import { Context } from '@temporalio/activity';
import { apiErrorSchema, leaseRenewedSchema, leaseResponseSchema, leaseStartedSchema, resultSubmittedSchema, runRecordMessage } from '@swarm-explorer/api-client';
import { leaseRequestKey, resultSubmitKey, resumeDecision } from '@swarm-explorer/node-core';
import { canonicalJson, checkHengeUpdate, checkJoinReadiness, type HengeResolveResult, type HengeV1 } from '@swarm-explorer/schema';
import { sha256Digest } from '@swarm-explorer/schema/node';
import type { HarnessRunResult, HarnessRunSpec } from '../../shared/node';
import type {
  AbandonReasonT,
  BundleCheckStep,
  GuardStep,
  HengePinRecord,
  JoinInput,
  JoinResolveStep,
  LeaseStep,
  LeaseSummary,
  RunStep,
  SealedResult,
  StartStep,
  SubmitStep,
  SwarmTaskInput,
  TaskProgress,
} from './types';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type TaskActivityDeps = {
  signedFetch: (method: Method, path: string, body?: unknown, idempotencyKey?: string) => Promise<Response>;
  signWithDevice: (message: string) => Promise<string>;
  appVersion: string;
  /** Pause, sign in, kill switch, run rules and the daily cap, checked before work and before every model call. */
  guard: (input: SwarmTaskInput, leaseId: string) => GuardStep;
  /** Why the runner stopped this lease (Pause, leave, a rule stop), if it did. */
  stopFor: (leaseId: string) => { reason: AbandonReasonT; detail: string } | null;
  /** Registers the run's abort controller, so Pause stops the sandbox at once. Returns an unregister. */
  registerAbort: (leaseId: string, ctl: AbortController) => () => void;
  /** Builds the sandbox run for this lease (fetches or reuses the signed harness bundle). */
  runSpec: (input: SwarmTaskInput, leaseId: string, taskInput: Record<string, unknown>, signal: AbortSignal) => Promise<HarnessRunSpec>;
  run: (spec: HarnessRunSpec, signal: AbortSignal) => Promise<HarnessRunResult>;
  progress: (input: SwarmTaskInput, p: Partial<TaskProgress> & { leaseId: string | null }) => void;
  checkKill: () => Promise<void>;
  now?: () => number;
  /** How often the run step heartbeats. Engineering value, shortened in tests. */
  heartbeatMs?: number;
};

const KILL_CODES = new Set(['killed', 'swarm_killed', 'lease_cancelled']);
/** Coordinator answers after which the lease is already closed, so there is nothing to abandon. */
const CLOSED_CODES = new Set(['lease_expired', 'lease_abandoned', 'lease_cancelled', 'not_found']);

async function errorOf(res: Response) {
  const e = apiErrorSchema.safeParse(await res.json().catch(() => null));
  return e.success ? e.data.error : { code: `http_${res.status}`, message: 'The coordinator could not do that right now.' };
}

/** A transient failure: thrown so Temporal retries the step with the same idempotency key. */
class Transient extends Error {}

type StepContext = { attempt: number; heartbeat: (d?: unknown) => void; cancelled: AbortSignal };

/** The Temporal activity context, or a plain one when the in-process engine calls the step directly. */
function stepContext(): StepContext {
  try {
    const c = Context.current();
    return { attempt: c.info.attempt, heartbeat: (d) => c.heartbeat(d), cancelled: c.cancellationSignal };
  } catch {
    return { attempt: 1, heartbeat: () => {}, cancelled: new AbortController().signal };
  }
}

export function createTaskActivities(d: TaskActivityDeps) {
  const now = () => (d.now ?? Date.now)();
  return {
    async leaseTask(input: SwarmTaskInput, workflowId: string): Promise<LeaseStep> {
      d.progress(input, { leaseId: null, phase: 'leasing' });
      const res = await d.signedFetch(
        'POST',
        `/v1/coordinators/${input.swarm}/leases`,
        { node_id: input.nodeId, mode: 'local', model_artifact_hash: input.model.contentHash, reputation_token: null, spend_reservation: null },
        leaseRequestKey(workflowId),
      );
      if (res.status >= 500) throw new Transient(`The coordinator answered ${res.status}.`);
      if (!res.ok) {
        const e = await errorOf(res);
        const kill = KILL_CODES.has(e.code);
        if (kill) await d.checkKill();
        return { kind: 'none', code: e.code, message: e.message, kill };
      }
      const body = leaseResponseSchema.safeParse(await res.json());
      if (!body.success || !body.data.lease) return { kind: 'none', code: body.success ? (body.data.unavailable?.code ?? 'no_tasks') : 'invalid_response', message: 'No tasks waiting in your swarms.', kill: false };
      const l = body.data.lease;
      return {
        kind: 'lease',
        lease: { leaseId: l.lease_id, taskId: l.task_id, swarm: l.swarm, urgent: l.urgent, harnessHash: l.harness.hash, permissionsHash: l.permissions_hash, inputSha256: l.input.sha256, leasedAt: now(), deadlineAt: l.deadline_at },
      };
    },

    async startLease(input: SwarmTaskInput, lease: LeaseSummary): Promise<StartStep> {
      d.progress(input, { leaseId: lease.leaseId, phase: 'starting', deadlineAt: lease.deadlineAt, urgent: lease.urgent });
      // Starting a running lease again returns its input, so a retried start is safe.
      const res = await d.signedFetch('POST', `/v1/leases/${lease.leaseId}/start`, { harness_hash: input.harnessHash, permissions_hash: input.permissionsHash, model_artifact_hash: input.model.contentHash }, `henge-start-${lease.leaseId}`);
      if (res.status >= 500) throw new Transient(`The coordinator answered ${res.status}.`);
      if (!res.ok) {
        const e = await errorOf(res);
        const kill = KILL_CODES.has(e.code);
        if (kill) void d.checkKill();
        return { ok: false, code: e.code, message: e.message, kill, abandon: !kill && !CLOSED_CODES.has(e.code) };
      }
      const started = leaseStartedSchema.parse(await res.json());
      if (sha256Digest(canonicalJson(started.input)) !== lease.inputSha256)
        return { ok: false, code: 'input_hash_mismatch', message: 'The task input did not match its pinned hash, so it was not run.', kill: false, abandon: true };
      return { ok: true, input: started.input, deadlineAt: started.deadline_at };
    },

    async guard(input: SwarmTaskInput, leaseId: string): Promise<GuardStep> {
      return d.guard(input, leaseId);
    },

    async runHarness(input: SwarmTaskInput, lease: LeaseSummary, taskInput: Record<string, unknown>, deadlineAt: string): Promise<RunStep> {
      const ctx = stepContext();
      let deadline = Date.parse(deadlineAt);
      const renew = async () => {
        try {
          const res = await d.signedFetch('POST', `/v1/leases/${lease.leaseId}/renew`);
          const body = leaseRenewedSchema.safeParse(await res.json().catch(() => null));
          if (res.ok && body.success) {
            deadline = Date.parse(body.data.deadline_at);
            d.progress(input, { leaseId: lease.leaseId, deadlineAt: body.data.deadline_at });
            return true;
          }
        } catch {
          // The deadline stands.
        }
        return false;
      };
      // A retry means the previous attempt died with its worker: renew or abandon cleanly first.
      if (ctx.attempt > 1) {
        const r = resumeDecision({ step: 'run', leasedAt: lease.leasedAt, deadlineAt: deadline, now: now() });
        if (r.action === 'abandon') return { status: 'expired', detail: 'The lease ended while this computer was away. The task went back to the queue, unpaid.' };
        if (r.action === 'renew') await renew();
      }
      const g = d.guard(input, lease.leaseId);
      if (!g.ok) return { status: 'stopped', reason: g.reason, detail: g.detail };
      d.progress(input, { leaseId: lease.leaseId, phase: 'running' });

      const ctl = new AbortController();
      const unregister = d.registerAbort(lease.leaseId, ctl);
      const onCancel = () => ctl.abort();
      ctx.cancelled.addEventListener('abort', onCancel, { once: true });
      let renewTried = false;
      const beat = setInterval(() => {
        ctx.heartbeat({ at: now() });
        // Ask for more time once, when a fifth of the lease is left (the M5 rule).
        if (!renewTried && deadline - now() <= (deadline - lease.leasedAt) / 5) {
          renewTried = true;
          void renew().then((ok) => {
            if (ok) renewTried = false;
          });
        }
      }, d.heartbeatMs ?? 2_000);
      const t0 = now();
      try {
        ctx.heartbeat({ at: t0 });
        const spec = await d.runSpec(input, lease.leaseId, taskInput, ctl.signal);
        const r = await d.run(spec, ctl.signal);
        const stop = d.stopFor(lease.leaseId);
        if (stop) return { status: 'stopped', reason: stop.reason, detail: stop.detail };
        if (r.status === 'cancelled') return { status: 'stopped', reason: 'local_failure', detail: 'The task could not run here. It went back to the queue, unpaid.' };
        if (r.status !== 'ok' || !r.output) {
          // The daily cap refusing a model call ends the run; the guard says why.
          const why = d.guard(input, lease.leaseId);
          if (!why.ok) return { status: 'stopped', reason: why.reason, detail: why.detail };
          return { status: 'failed', detail: `${r.detail} The task went back to the queue, unpaid.`.slice(0, 300) };
        }
        return {
          status: 'ok',
          output: r.output,
          tokens: { input: r.tokens?.input ?? null, output: r.tokens?.output ?? null },
          fuel: r.fuel && r.fuel.used !== null ? { meter: r.fuel.meter, used: r.fuel.used, budget: r.fuel.budget } : null,
          elapsedMs: now() - t0,
        };
      } finally {
        clearInterval(beat);
        ctx.cancelled.removeEventListener('abort', onCancel);
        unregister();
      }
    },

    /** Builds and signs the result once. Its return value is journaled, so every submit attempt sends these exact bytes. */
    async sealResult(input: SwarmTaskInput, lease: LeaseSummary, run: Extract<RunStep, { status: 'ok' }>): Promise<SealedResult> {
      d.progress(input, { leaseId: lease.leaseId, phase: 'submitting' });
      const outputSha256 = sha256Digest(canonicalJson(run.output));
      // Record version 2 carries the deterministic fuel count, so verifiers can compare runs.
      const metering = run.fuel ? { meter: run.fuel.meter, fuel_used: run.fuel.used, fuel_budget: run.fuel.budget } : null;
      const record = {
        ...(metering ? { record_version: 2 as const, metering } : {}),
        lease_id: lease.leaseId,
        node_id: input.nodeId,
        model: { source: 'local' as const, claimed_id: input.model.slug, artifact_hash: input.model.contentHash },
        harness_hash: input.harnessHash,
        tokens: run.tokens,
        elapsed_ms: run.elapsedMs,
        api_cost: { reported_usd_micros: null, provider_request_ids: [] },
        output_sha256: outputSha256,
        client_version: d.appVersion,
      };
      const signature = await d.signWithDevice(runRecordMessage(canonicalJson(record)));
      return { body: { output: run.output, output_sha256: outputSha256, run_record: { ...record, signature } }, outputSha256 };
    },

    async submitResult(leaseId: string, sealed: SealedResult): Promise<SubmitStep> {
      const res = await d.signedFetch('POST', `/v1/leases/${leaseId}/results`, sealed.body, resultSubmitKey(leaseId));
      if (res.status >= 500) throw new Transient(`The coordinator answered ${res.status}.`);
      if (!res.ok) return { ok: false, ...(await errorOf(res)) };
      const done = resultSubmittedSchema.parse(await res.json());
      return { ok: true, disposition: done.disposition, duplicate: done.duplicate, replayed: res.headers.get('idempotent-replay') === 'true', resultId: done.result_id };
    },

    async abandonLease(leaseId: string, reason: AbandonReasonT): Promise<void> {
      const res = await d.signedFetch('POST', `/v1/leases/${leaseId}/abandon`, { reason }, `henge-abandon-${leaseId}`);
      if (res.status >= 500) throw new Transient(`The coordinator answered ${res.status}.`);
    },
  };
}

export type TaskActivities = ReturnType<typeof createTaskActivities>;

/* ---------------------------------------------------------------------------------------------
 * Henge bundles: join and scheduled updates (spin-out spec v2, 6.4, 6.5).
 * ------------------------------------------------------------------------------------------- */

export type BundleActivityDeps = {
  resolve: (url: string) => Promise<HengeResolveResult>;
  pins: { get: (id: string) => HengePinRecord | null; set: (p: HengePinRecord) => void };
  manifests: { get: (id: string) => HengeV1 | null; set: (id: string, h: HengeV1) => void; getPending: (id: string) => HengeV1 | null; setPending: (id: string, h: HengeV1 | null) => void };
  /** Holds (or releases) the node for a Henge whose update needs re-consent. */
  hold: (hengeId: string, held: boolean) => void;
  now?: () => number;
};

const issueText = (i: { code: string; message: string }) => ({ code: i.code, message: i.message });

export function createBundleActivities(d: BundleActivityDeps) {
  const now = () => (d.now ?? Date.now)();
  return {
    async resolveForJoin(input: JoinInput): Promise<JoinResolveStep> {
      const r = await d.resolve(input.url);
      if (!r.ok) return { ok: false, issues: r.issues.map(issueText) };
      const ready = checkJoinReadiness(r.henge, { daily_cap: input.dailyCapUsdMicros === null ? null : input.dailyCapUsdMicros / 1_000_000 });
      if (ready.length) return { ok: false, issues: ready.map(issueText) };
      d.manifests.set(r.henge.id, r.henge);
      const pin: HengePinRecord = {
        id: r.henge.id,
        url: r.pin.url,
        commit: r.pin.commit,
        etag: r.pin.etag,
        bundleDigest: r.pin.bundle_digest,
        version: r.pin.version,
        name: r.henge.name,
        admissionMode: r.henge.admission.mode,
        reconsentOn: [...r.henge.governance.rule_updates.member_reconsent_on],
        dailyCapUsdMicros: input.dailyCapUsdMicros,
        joinedAt: now(),
        status: r.henge.admission.mode === 'request' ? 'awaiting_admission' : 'joined',
        pending: null,
      };
      return { ok: true, pin, bundleWorkflowId: `henge-bundle-${createHash('sha256').update(pin.id).digest('hex').slice(0, 32)}` };
    },

    async savePin(pin: HengePinRecord): Promise<void> {
      d.pins.set(pin);
    },

    async markAdmitted(id: string): Promise<void> {
      const p = d.pins.get(id);
      if (p) d.pins.set({ ...p, status: 'joined' });
    },

    /** Fetches the pinned URL again and diffs it against the pinned manifest (6.5 step 5). */
    async checkBundleUpdate(id: string): Promise<BundleCheckStep> {
      const pin = d.pins.get(id);
      const prev = d.manifests.get(id);
      if (!pin || !prev) return { kind: 'gone' };
      const r = await d.resolve(pin.url);
      if (!r.ok) return { kind: 'error', message: r.issues[0]?.message ?? 'The update could not be read.' };
      if (r.pin.bundle_digest === pin.bundleDigest) return { kind: 'unchanged' };
      const chk = checkHengeUpdate(prev, r.henge);
      if (r.henge.id !== prev.id) chk.issues.push({ code: 'id_changed', path: '/id', message: 'The update names a different Henge id.' });
      d.manifests.setPending(id, r.henge);
      return { kind: 'update', version: r.pin.version, bundleDigest: r.pin.bundle_digest, etag: r.pin.etag, commit: r.pin.commit, reconsent: chk.reconsent, issues: chk.issues.map((i) => i.message) };
    },

    async holdForReconsent(id: string, c: Extract<BundleCheckStep, { kind: 'update' }>): Promise<void> {
      const pin = d.pins.get(id);
      if (!pin) return;
      d.pins.set({ ...pin, status: 'awaiting_reconsent', pending: { version: c.version, bundleDigest: c.bundleDigest, etag: c.etag, commit: c.commit, fields: c.reconsent } });
      d.hold(id, true);
    },

    async applyUpdate(id: string, c: Extract<BundleCheckStep, { kind: 'update' }>): Promise<void> {
      const pin = d.pins.get(id);
      const next = d.manifests.getPending(id);
      if (!pin) return;
      if (next) d.manifests.set(id, next);
      d.manifests.setPending(id, null);
      d.pins.set({ ...pin, version: c.version, bundleDigest: c.bundleDigest, etag: c.etag, commit: c.commit, status: 'joined', pending: null, reconsentOn: next ? [...next.governance.rule_updates.member_reconsent_on] : pin.reconsentOn });
      d.hold(id, false);
    },
  };
}

export type BundleActivities = ReturnType<typeof createBundleActivities>;
