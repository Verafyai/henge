/**
 * Task runner in the main process (SPEC 7.1 to 7.3, 13.3). The node always pulls: it asks the
 * hosted coordinator for a lease, never accepts a connection. One local task at a time (local GPU
 * concurrency is one).
 *
 * Each pass: check Pause, sign in and the run rules; let the fair share scheduler order the
 * qualified swarms that have work; lease from the first that has a task; verify the pins; start
 * the lease, which hands out the input; check the input against its pinned hash; run the signed
 * harness in the sandbox against the user's own model; sign a run record with the device key and
 * submit. Pause, leave, a run rule stop and local failures abandon the lease (unpaid, requeued).
 *
 * Submitted results wait for verification, which arrives in M6. Volunteer work earns impact only.
 */
import {
  apiErrorSchema,
  leaseRenewedSchema,
  leaseResponseSchema,
  leaseStartedSchema,
  resultSubmittedSchema,
  runRecordMessage,
  type AbandonReason,
  type Lease,
  type MembershipView,
} from '@swarm-explorer/api-client';
import { evaluateRunRules, FairShareScheduler, runRulesSchema, DEFAULT_RUN_RULES, type EnforcementSupport, type GateDecision, type RunRules, type Sensors } from '@swarm-explorer/node-core';
import { canonicalJson } from '@swarm-explorer/schema';
import { sha256Digest } from '@swarm-explorer/schema/node';
import type { HarnessRunResult, HarnessRunSpec, InstalledModel, TaskHistoryItem, TaskRunView, TasksOverview } from '../shared/node';
import type { AuthManager } from './auth';
import type { EncryptedCache } from './cache';
import type { MembershipManager, PreparedRun } from './memberships';

type Deps = {
  auth: AuthManager;
  cache: () => EncryptedCache;
  memberships: Pick<MembershipManager, 'overview' | 'refresh' | 'prepareRun' | 'pickModel' | 'runSpec'>;
  nodeId: () => string | null;
  isPaused: () => boolean;
  run: (spec: HarnessRunSpec, signal: AbortSignal) => Promise<HarnessRunResult>;
  sensors: () => Sensors;
  support: EnforcementSupport;
  appVersion: string;
  changed: () => void;
  /** Engineering intervals, shortened in tests. */
  tickMs?: number;
};

/** How often the runner checks rules and work. Engineering value, not a business rule. */
const TICK_MS = 2_000;
/** How long a swarm that had nothing to lease is skipped before asking again. Engineering value. */
const EMPTY_BACKOFF_MS = 30_000;
/** How often store home (queue counts) is refreshed while waiting. Engineering value. */
const HOME_REFRESH_MS = 30_000;
const HISTORY = 20;

type Current = TaskRunView & { membershipId: string; modelHash: string; ctl: AbortController; stop: { reason: AbandonReason; detail: string } | null; renewTried: boolean };

const STOP_DETAIL: Record<AbandonReason, string> = {
  paused: 'Paused. The task went back to the queue, unpaid.',
  left: 'You left the swarm. The task went back to the queue, unpaid.',
  run_rules: 'A run rule stopped the task. It went back to the queue, unpaid.',
  local_failure: 'The task could not run here. It went back to the queue, unpaid.',
  signed_out: 'Signed out. The task went back to the queue, unpaid.',
  pin_mismatch: 'The harness or permissions did not match. The task went back to the queue, unpaid.',
};

async function errorOf(res: Response) {
  const e = apiErrorSchema.safeParse(await res.json().catch(() => null));
  return e.success ? e.data.error : { code: `http_${res.status}`, message: 'The coordinator could not do that right now.' };
}

export class TaskRunner {
  private readonly scheduler = new FairShareScheduler();
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Current | null = null;
  private history: TaskHistoryItem[] = [];
  private emptyUntil = new Map<string, number>();
  private gate: GateDecision | null = null;
  private phase: TasksOverview['phase'] = 'off';
  private detail = 'Sign in to run tasks.';
  private ticking = false;
  private lastHome = 0;
  private recovered = false;
  /** The running task's loop, so sign out can wait for its abandon to reach the coordinator. */
  private running: Promise<void> | null = null;

  constructor(private d: Deps) {}

  start() {
    this.timer ??= setInterval(() => void this.tick(), this.d.tickMs ?? TICK_MS);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  rules(): RunRules {
    const r = runRulesSchema.safeParse(this.d.cache().get('run-rules'));
    return r.success ? r.data : DEFAULT_RUN_RULES;
  }

  setRules(r: RunRules) {
    this.d.cache().set('run-rules', runRulesSchema.parse(r));
    this.d.changed();
    void this.tick();
  }

  /** The model of the running lease; it may not be removed while the task runs. */
  leasedModel(): string | null {
    return this.current?.modelHash ?? null;
  }

  overview(): TasksOverview {
    const c = this.current;
    return {
      phase: this.phase,
      detail: this.detail,
      current: c ? { leaseId: c.leaseId, taskId: c.taskId, swarm: c.swarm, urgent: c.urgent, phase: c.phase, model: c.model, startedAt: c.startedAt, deadlineAt: c.deadlineAt } : null,
      history: this.history,
      gate: this.gate,
      shares: this.scheduler.report(),
    };
  }

  private set(phase: TasksOverview['phase'], detail: string) {
    if (this.phase === phase && this.detail === detail) return;
    this.phase = phase;
    this.detail = detail;
    this.d.changed();
  }

  private record(item: Omit<TaskHistoryItem, 'at'>) {
    this.history = [{ ...item, at: Date.now() }, ...this.history].slice(0, HISTORY);
  }

  /** Stops the running task at once; the run loop then abandons the lease. */
  stopCurrent(reason: AbandonReason, detail = STOP_DETAIL[reason]) {
    const c = this.current;
    if (!c || c.stop) return;
    c.stop = { reason, detail };
    c.ctl.abort();
    this.d.changed();
  }

  /** Pause: the sandbox is stopped by the supervisor; here the lease is abandoned and no new one starts. */
  pause() {
    this.stopCurrent('paused');
    this.set('paused', 'Paused. No new tasks until you resume.');
  }

  resume() {
    void this.tick();
  }

  onLeave(membershipId: string) {
    if (this.current?.membershipId === membershipId) this.stopCurrent('left');
    this.scheduler.remove(membershipId);
  }

  /** Stops the running task and waits until its lease is abandoned (best effort), for sign out. */
  async drain(reason: AbandonReason) {
    this.stopCurrent(reason);
    await this.running;
  }

  onSignedOut() {
    this.stopCurrent('signed_out');
    this.recovered = false;
  }

  private signedIn() {
    return this.d.auth.getState().status === 'signed_in' && Boolean(this.d.nodeId());
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const gate = evaluateRunRules(this.rules(), this.d.sensors(), this.d.support, new Date());
      const changed = JSON.stringify(gate) !== JSON.stringify(this.gate);
      this.gate = gate;
      if (changed) this.d.changed();
      if (this.current) {
        if (gate.mustStop) this.stopCurrent('run_rules', `${gate.blocks[0]!.detail} The task went back to the queue, unpaid.`);
        else await this.maybeRenew();
        return;
      }
      if (!this.signedIn()) return this.set('off', 'Sign in to run tasks.');
      if (this.d.isPaused()) return this.set('paused', 'Paused. No new tasks until you resume.');
      await this.recover();
      if (Date.now() - this.lastHome > HOME_REFRESH_MS) {
        this.lastHome = Date.now();
        await this.d.memberships.refresh();
      }
      const active = (this.d.memberships.overview().home?.joined ?? []).filter((m) => m.status === 'active');
      if (!active.length) return this.set('off', 'No qualified swarm yet. Tasks start after a swarm qualifies.');
      if (!gate.canStart) return this.set('blocked', gate.blocks[0]!.detail);
      const now = Date.now();
      const order = this.scheduler.order(
        active.map((m) => ({ id: m.id, shareBp: m.share_bp, eligible: (this.emptyUntil.get(m.id) ?? 0) <= now, queued: m.queue?.queued ?? 0, urgent: m.queue?.urgent ?? 0 })),
      );
      if (!order.length) return this.set('waiting', 'No tasks waiting in your swarms.');
      for (const id of order) {
        if (this.d.isPaused() || this.current) return;
        if (await this.lease(active.find((m) => m.id === id)!)) return;
      }
      if (!this.current) this.set('waiting', 'No tasks waiting in your swarms.');
    } finally {
      this.ticking = false;
    }
  }

  /** Leases left open by a previous session (for example after a crash) are returned at once. */
  private async recover() {
    if (this.recovered) return;
    const home = this.d.memberships.overview().home ?? (await this.d.memberships.refresh());
    if (!home) return;
    this.recovered = true;
    for (const l of home.node.open_leases) await this.abandon(l.id, 'local_failure');
    if (home.node.open_leases.length) await this.d.memberships.refresh();
  }

  private skip(membershipId: string) {
    this.scheduler.markIdle(membershipId);
    this.emptyUntil.set(membershipId, Date.now() + EMPTY_BACKOFF_MS);
  }

  /** Asks one swarm's coordinator for a lease. True when a task started. */
  private async lease(m: MembershipView): Promise<boolean> {
    this.set('leasing', `Asking ${m.swarm} for a task`);
    const ctl = new AbortController();
    let prepared: PreparedRun;
    try {
      prepared = await this.d.memberships.prepareRun(m, ctl.signal);
    } catch (e) {
      this.skip(m.id);
      this.set('waiting', e instanceof Error ? e.message.slice(0, 200) : 'The harness could not be prepared.');
      return false;
    }
    const model = this.d.memberships.pickModel(prepared.accepted);
    if (!model) {
      this.skip(m.id);
      this.set('waiting', `None of your downloaded models is accepted by ${m.swarm}.`);
      return false;
    }
    let lease: Lease;
    try {
      const res = await this.d.auth.signedFetch('POST', `/v1/coordinators/${m.swarm}/leases`, { node_id: this.d.nodeId(), mode: 'local', model_artifact_hash: model.contentHash, reputation_token: null, spend_reservation: null });
      if (!res.ok) {
        const e = await errorOf(res);
        this.skip(m.id);
        this.set('waiting', e.message);
        return false;
      }
      const body = leaseResponseSchema.safeParse(await res.json());
      if (!body.success || !body.data.lease) {
        this.skip(m.id);
        return false;
      }
      lease = body.data.lease;
    } catch {
      this.skip(m.id);
      this.set('waiting', 'The coordinator could not be reached.');
      return false;
    }
    // The node checks the pins itself before it runs anything (SPEC 7.3).
    if (lease.swarm !== m.swarm || lease.harness.hash !== prepared.release.bundleHash || lease.permissions_hash !== m.permissions_hash) {
      await this.abandon(lease.lease_id, 'pin_mismatch');
      this.record({ leaseId: lease.lease_id, swarm: m.swarm, outcome: 'abandoned', detail: STOP_DETAIL.pin_mismatch, elapsedMs: 0 });
      this.skip(m.id);
      return false;
    }
    this.current = {
      leaseId: lease.lease_id,
      taskId: lease.task_id,
      swarm: m.swarm,
      urgent: lease.urgent,
      phase: 'starting',
      model: model.displayName,
      modelHash: model.contentHash,
      startedAt: Date.now(),
      deadlineAt: lease.deadline_at,
      membershipId: m.id,
      ctl,
      stop: null,
      renewTried: false,
    };
    this.set('running', `Running a task for ${m.swarm} on ${model.displayName}`);
    this.running = this.execute(m, prepared, model, lease, this.current).finally(() => {
      this.running = null;
    });
    return true;
  }

  private async execute(m: MembershipView, prepared: PreparedRun, model: InstalledModel, lease: Lease, c: Current) {
    const t0 = Date.now();
    const finish = (item: Omit<TaskHistoryItem, 'at' | 'leaseId' | 'swarm' | 'elapsedMs'>) => this.record({ leaseId: lease.lease_id, swarm: m.swarm, elapsedMs: Date.now() - t0, ...item });
    try {
      if (this.d.isPaused()) this.stopCurrent('paused');
      if (c.stop) throw new Error('stopped');
      const sres = await this.d.auth.signedFetch('POST', `/v1/leases/${lease.lease_id}/start`, { harness_hash: prepared.release.bundleHash, permissions_hash: m.permissions_hash, model_artifact_hash: model.contentHash });
      if (!sres.ok) {
        const e = await errorOf(sres);
        await this.abandon(lease.lease_id, e.code === 'pin_mismatch' ? 'pin_mismatch' : 'local_failure');
        return finish({ outcome: 'abandoned', detail: e.message });
      }
      const started = leaseStartedSchema.parse(await sres.json());
      if (sha256Digest(canonicalJson(started.input)) !== lease.input.sha256) {
        await this.abandon(lease.lease_id, 'local_failure');
        return finish({ outcome: 'failed', detail: 'The task input did not match its pinned hash, so it was not run.' });
      }
      c.deadlineAt = started.deadline_at;
      c.phase = 'running';
      this.d.changed();
      const r = await this.d.run(this.d.memberships.runSpec(m, prepared, model, lease.lease_id, started.input), c.ctl.signal);
      if (c.stop || r.status === 'cancelled') throw new Error('stopped');
      if (r.status !== 'ok' || !r.output) {
        await this.abandon(lease.lease_id, 'local_failure');
        return finish({ outcome: 'failed', detail: `${r.detail} The task went back to the queue, unpaid.`.slice(0, 300) });
      }
      c.phase = 'submitting';
      this.d.changed();
      const output = r.output;
      const outputHash = sha256Digest(canonicalJson(output));
      // Record version 2 carries the deterministic fuel count, so verifiers can compare runs.
      const metering = r.fuel && r.fuel.used !== null ? { meter: r.fuel.meter, fuel_used: r.fuel.used, fuel_budget: r.fuel.budget } : null;
      const record = {
        ...(metering ? { record_version: 2 as const, metering } : {}),
        lease_id: lease.lease_id,
        node_id: this.d.nodeId()!,
        model: { source: 'local' as const, claimed_id: model.slug, artifact_hash: model.contentHash },
        harness_hash: prepared.release.bundleHash,
        tokens: { input: r.tokens?.input ?? null, output: r.tokens?.output ?? null },
        elapsed_ms: Date.now() - t0,
        api_cost: { reported_usd_micros: null, provider_request_ids: [] },
        output_sha256: outputHash,
        client_version: this.d.appVersion,
      };
      const signature = await this.d.auth.signWithDevice(runRecordMessage(canonicalJson(record)));
      const body = { output, output_sha256: outputHash, run_record: { ...record, signature } };
      // Submit is idempotent by lease and result hash, so a retry after a dropped connection is safe.
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await this.d.auth.signedFetch('POST', `/v1/leases/${lease.lease_id}/results`, body);
          if (res.status >= 500 && attempt < 2) continue;
          if (!res.ok) return finish({ outcome: 'failed', detail: (await errorOf(res)).message });
          const done = resultSubmittedSchema.parse(await res.json());
          return finish(
            done.disposition === 'on_time'
              ? { outcome: 'submitted', detail: 'Submitted. It waits for the swarm to verify it.' }
              : { outcome: 'late', detail: 'Submitted after the lease ended, so it is recorded but not counted.' },
          );
        } catch (e) {
          if (attempt >= 2) throw e;
        }
      }
    } catch {
      const stop = c.stop ?? { reason: 'local_failure' as const, detail: STOP_DETAIL.local_failure };
      await this.abandon(lease.lease_id, stop.reason);
      finish({ outcome: 'abandoned', detail: stop.detail });
    } finally {
      // Time used is charged to the swarm's share, urgent or not (SPEC 7.1).
      this.scheduler.charge(m.id, Date.now() - t0, lease.urgent);
      this.current = null;
      this.lastHome = Date.now();
      await this.d.memberships.refresh().catch(() => null);
      if (this.d.isPaused()) this.set('paused', 'Paused. No new tasks until you resume.');
      else this.set('waiting', 'Looking for the next task.');
      this.d.changed();
      void this.tick();
    }
  }

  /** Abandon is best effort: if it never arrives, the lease expires at its deadline and requeues. */
  private async abandon(leaseId: string, reason: AbandonReason) {
    try {
      await this.d.auth.signedFetch('POST', `/v1/leases/${leaseId}/abandon`, { reason });
    } catch {
      // Offline or signed out.
    }
  }

  /**
   * Asks for more time once, when a fifth of the lease is left. The coordinator may refuse (no
   * renewal policy is approved yet); the task keeps running and a late result is recorded unpaid.
   */
  private async maybeRenew() {
    const c = this.current;
    if (!c || c.phase !== 'running' || c.renewTried) return;
    const end = Date.parse(c.deadlineAt);
    if (end - Date.now() > (end - c.startedAt) / 5) return;
    c.renewTried = true;
    try {
      const res = await this.d.auth.signedFetch('POST', `/v1/leases/${c.leaseId}/renew`);
      const body = leaseRenewedSchema.safeParse(await res.json().catch(() => null));
      if (res.ok && body.success) {
        c.deadlineAt = body.data.deadline_at;
        c.renewTried = false;
        this.d.changed();
      }
    } catch {
      // The deadline stands.
    }
  }
}
