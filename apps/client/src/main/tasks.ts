/**
 * Task runner in the main process (SPEC 7.1 to 7.3, 13.3; spin-out spec v2, 9.3). The node always
 * pulls: it asks the hosted coordinator for a lease, never accepts a connection. One local task at
 * a time (local GPU concurrency is one).
 *
 * Each pass: check Pause, sign in, the kill switch, the run rules and the daily cap; let the fair
 * share scheduler order the qualified swarms that have work; prepare the first swarm's signed
 * harness; then start one SwarmTaskWorkflow on the durable engine (Temporal in the node). The
 * workflow leases, verifies the pins, starts the lease, checks the input hash, runs the harness in
 * the sandbox against the user's own model, seals and signs the result and submits it once. If
 * the node or its worker is killed, the workflow resumes on the next start instead of being lost;
 * leases no workflow owns are returned (recovery.ts). Pause, leave, a run rule stop, the daily cap
 * and local failures abandon the lease (unpaid, requeued).
 *
 * Submitted results wait for verification (M6). Volunteer work earns impact only.
 */
import { evaluateRunRules, FairShareScheduler, runRulesSchema, DEFAULT_RUN_RULES, DAILY_CAP_PAUSED, type CapDecision, type EnforcementSupport, type GateDecision, type RunRules, type Sensors } from '@swarm-explorer/node-core';
import { planRecovery } from '@swarm-explorer/node-core/recovery';
import type { AbandonReason, MembershipView } from '@swarm-explorer/api-client';
import type { HarnessRunResult, HarnessRunSpec, TaskHistoryItem, TaskRunView, TasksOverview } from '../shared/node';
import type { AuthManager } from './auth';
import type { EncryptedCache } from './cache';
import type { KillSwitchWatcher } from './kill-switch';
import type { MembershipManager } from './memberships';
import { createTaskActivities, type TaskActivities } from './temporal/activities';
import { InProcessEngine, type WorkflowEngine } from './temporal/engine';
import type { GuardStep, SwarmTaskInput, TaskOutcome, TaskProgress } from './temporal/types';

type Deps = {
  auth: AuthManager;
  cache: () => EncryptedCache;
  memberships: Pick<MembershipManager, 'overview' | 'refresh' | 'prepareRun' | 'pickModel' | 'runSpec'>;
  nodeId: () => string | null;
  isPaused: () => boolean;
  /** Why the node is paused, when it is not the user's own Pause (for example the daily cap). */
  pausedDetail?: () => string | null;
  run: (spec: HarnessRunSpec, signal: AbortSignal) => Promise<HarnessRunResult>;
  sensors: () => Sensors;
  support: EnforcementSupport;
  appVersion: string;
  changed: () => void;
  /** The signed kill switch (M7). Absent only in tests that do not cover it. */
  kill?: Pick<KillSwitchWatcher, 'stoppedReason' | 'startBlock' | 'check'>;
  /** The daily cap (spin-out 6.4). Absent in tests that do not cover it. */
  budget?: { check: () => CapDecision };
  /** The cap was reached: pause the node (`hard_stop`). */
  onCapReached?: () => void;
  /** The durable engine, built over this runner's activities. Defaults to the in-process engine. */
  engine?: (activities: TaskActivities) => WorkflowEngine;
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

/** The task workflow this node is running (at most one). */
type Current = {
  workflowId: string;
  input: SwarmTaskInput;
  progress: TaskProgress;
  startedAt: number;
  stop: { reason: AbandonReason; detail: string } | null;
  ctl: AbortController | null;
  resumed: boolean;
  /** Resolves once the workflow holds a lease (true) or ended without running anything (false). */
  settle: (leased: boolean) => void;
};

const noop = () => {};

const STOP_DETAIL: Record<AbandonReason, string> = {
  paused: 'Paused. The task went back to the queue, unpaid.',
  left: 'You left the swarm. The task went back to the queue, unpaid.',
  run_rules: 'A run rule stopped the task. It went back to the queue, unpaid.',
  local_failure: 'The task could not run here. It went back to the queue, unpaid.',
  signed_out: 'Signed out. The task went back to the queue, unpaid.',
  pin_mismatch: 'The harness or permissions did not match. The task went back to the queue, unpaid.',
  kill_switch: 'Verafy stopped this work. The task went back to the queue, unpaid.',
};

const CAP_STOP = `${DAILY_CAP_PAUSED}. The task went back to the queue, unpaid.`;

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
  /** The running task's workflow, so sign out can wait for its abandon to reach the coordinator. */
  private running: Promise<void> | null = null;
  readonly activities: TaskActivities;
  private engine: WorkflowEngine;
  private engineReady = false;

  constructor(private d: Deps) {
    this.activities = createTaskActivities({
      signedFetch: (method, path, body, key) => d.auth.signedFetch(method, path, body, key),
      signWithDevice: (m) => d.auth.signWithDevice(m),
      appVersion: d.appVersion,
      guard: (input) => this.guard(input),
      stopFor: () => this.current?.stop ?? null,
      registerAbort: (_leaseId, ctl) => {
        const c = this.current;
        if (c) c.ctl = ctl;
        if (c?.stop) ctl.abort();
        return () => {
          if (c && c.ctl === ctl) c.ctl = null;
        };
      },
      runSpec: (input, leaseId, taskInput, signal) => this.runSpec(input, leaseId, taskInput, signal),
      run: (spec, signal) => d.run(spec, signal),
      progress: (_input, p) => this.onProgress(p),
      checkKill: async () => {
        await d.kill?.check();
      },
    });
    this.engine = d.engine ? d.engine(this.activities) : new InProcessEngine(this.activities);
    if (!d.engine) this.engineReady = true;
  }

  /** The engine started (or failed and the runner fell back to the in-process one). */
  setEngine(engine: WorkflowEngine) {
    this.engine = engine;
    this.engineReady = true;
    this.recovered = false;
    void this.tick();
  }

  get engineName() {
    return this.engine.name;
  }

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
    return this.current?.input.model.contentHash ?? null;
  }

  /** Whether the run rules let task model calls go ahead right now (the proxy's schedule guard). */
  scheduleOk(): boolean {
    return !(this.gate?.mustStop ?? false);
  }

  private view(c: Current): TaskRunView | null {
    const p = c.progress;
    if (!p.leaseId || p.phase === 'leasing' || p.phase === 'done') return null;
    return { leaseId: p.leaseId, taskId: '', swarm: c.input.swarm, urgent: p.urgent, phase: p.phase, model: c.input.model.displayName, startedAt: c.startedAt, deadlineAt: p.deadlineAt ?? '' };
  }

  overview(): TasksOverview {
    return {
      phase: this.phase,
      detail: this.detail,
      current: this.current ? this.view(this.current) : null,
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

  private pausedText() {
    return this.d.pausedDetail?.() ?? 'Paused. No new tasks until you resume.';
  }

  /** Stops the running task at once; its workflow then abandons the lease. */
  stopCurrent(reason: AbandonReason, detail = STOP_DETAIL[reason]) {
    const c = this.current;
    if (!c || c.stop) return;
    c.stop = { reason, detail };
    c.ctl?.abort();
    this.d.changed();
  }

  /** Pause: the sandbox is stopped by the supervisor; here the lease is abandoned and no new one starts. */
  pause() {
    const cap = this.d.pausedDetail?.() === DAILY_CAP_PAUSED;
    this.stopCurrent('paused', cap ? CAP_STOP : STOP_DETAIL.paused);
    this.set('paused', this.pausedText());
  }

  resume() {
    void this.tick();
  }

  /**
   * The kill state changed (M7): stop the running task at once if its swarm, or everything, is now
   * stopped, then let the next pass show why. Does not wait for a tick in progress.
   */
  applyKill() {
    const c = this.current;
    const why = c && this.d.kill?.stoppedReason(c.input.swarm);
    if (why) this.stopCurrent('kill_switch', `${why} The task went back to the queue, unpaid.`);
    const all = this.d.kill?.stoppedReason();
    if (all && !this.current) this.set('blocked', all);
    void this.tick();
  }

  onLeave(membershipId: string) {
    if (this.current?.input.membershipId === membershipId) this.stopCurrent('left');
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

  /**
   * Checked by the workflow before the harness starts and by the run step before and after it:
   * the stop the user or a rule asked for, sign in, Pause, the kill switch, the run rules and the
   * daily cap. The model proxy checks pause, run rules and the cap again before every model call.
   */
  guard(input: SwarmTaskInput): GuardStep {
    const c = this.current;
    if (c?.stop) return { ok: false, reason: c.stop.reason, detail: c.stop.detail };
    if (!this.signedIn()) return { ok: false, reason: 'signed_out', detail: STOP_DETAIL.signed_out };
    const cap = this.d.budget?.check();
    if (cap && !cap.ok) {
      this.d.onCapReached?.();
      return { ok: false, reason: 'paused', detail: CAP_STOP };
    }
    if (this.d.isPaused()) return { ok: false, reason: 'paused', detail: STOP_DETAIL.paused };
    const why = this.d.kill?.stoppedReason(input.swarm);
    if (why) return { ok: false, reason: 'kill_switch', detail: `${why} The task went back to the queue, unpaid.` };
    const gate = evaluateRunRules(this.rules(), this.d.sensors(), this.d.support, new Date());
    if (gate.mustStop) return { ok: false, reason: 'run_rules', detail: `${gate.blocks[0]!.detail} The task went back to the queue, unpaid.` };
    return { ok: true };
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
        const why = this.d.kill?.stoppedReason(this.current.input.swarm);
        if (why) this.stopCurrent('kill_switch', `${why} The task went back to the queue, unpaid.`);
        else if (gate.mustStop) this.stopCurrent('run_rules', `${gate.blocks[0]!.detail} The task went back to the queue, unpaid.`);
        return;
      }
      if (!this.signedIn()) return this.set('off', 'Sign in to run tasks.');
      if (!this.engineReady) return this.set('blocked', 'Starting the local workflow engine.');
      await this.recover();
      if (this.current) return;
      const cap = this.d.budget?.check();
      if (cap && !cap.ok) {
        this.d.onCapReached?.();
        return this.set('paused', DAILY_CAP_PAUSED);
      }
      if (this.d.isPaused()) return this.set('paused', this.pausedText());
      const block = this.d.kill?.startBlock();
      if (block) return this.set('blocked', block);
      if (Date.now() - this.lastHome > HOME_REFRESH_MS) {
        this.lastHome = Date.now();
        await this.d.memberships.refresh();
      }
      const qualified = (this.d.memberships.overview().home?.joined ?? []).filter((m) => m.status === 'active');
      if (!qualified.length) return this.set('off', 'No qualified swarm yet. Tasks start after a swarm qualifies.');
      const active = qualified.filter((m) => !this.d.kill?.stoppedReason(m.swarm));
      if (!active.length) return this.set('blocked', this.d.kill!.stoppedReason(qualified[0]!.swarm)!);
      if (!gate.canStart) return this.set('blocked', gate.blocks[0]!.detail);
      const now = Date.now();
      const order = this.scheduler.order(
        active.map((m) => ({ id: m.id, shareBp: m.share_bp, eligible: (this.emptyUntil.get(m.id) ?? 0) <= now, queued: m.queue?.queued ?? 0, urgent: m.queue?.urgent ?? 0 })),
      );
      if (!order.length) return this.set('waiting', 'No tasks waiting in your swarms.');
      for (const id of order) {
        if (this.d.isPaused() || this.current) return;
        if (await this.begin(active.find((m) => m.id === id)!)) return;
      }
      if (!this.current) this.set('waiting', 'No tasks waiting in your swarms.');
    } finally {
      this.ticking = false;
    }
  }

  /**
   * After a start: task workflows still open (the node or worker was killed) resume where they
   * stopped; open leases that no workflow owns are returned at once, unpaid.
   */
  private async recover() {
    if (this.recovered) return;
    const home = this.d.memberships.overview().home ?? (await this.d.memberships.refresh());
    if (!home) return;
    let open: Awaited<ReturnType<WorkflowEngine['openTasks']>>;
    try {
      open = await this.engine.openTasks();
    } catch {
      return; // The engine is not answering yet; try again next pass.
    }
    const plan = planRecovery(
      home.node.open_leases.map((l) => ({ id: l.id, status: l.status, deadlineAt: l.deadline_at, swarm: l.swarm })),
      open.map((w) => ({ workflowId: w.workflowId, leaseId: w.progress?.leaseId ?? null })),
    );
    if (!plan.deferred) this.recovered = true;
    for (const id of plan.abandon) await this.abandon(id, 'local_failure');
    if (plan.abandon.length) await this.d.memberships.refresh();
    const first = open[0];
    if (first && !this.current) {
      this.current = { workflowId: first.workflowId, input: first.input, progress: first.progress ?? { leaseId: null, phase: 'leasing', deadlineAt: null, urgent: false }, startedAt: Date.now(), stop: null, ctl: null, resumed: true, settle: noop };
      this.set('running', `Resuming a task for ${first.input.swarm} on ${first.input.model.displayName}`);
      this.follow(this.current, first.result);
    }
  }

  private skip(membershipId: string) {
    this.scheduler.markIdle(membershipId);
    this.emptyUntil.set(membershipId, Date.now() + EMPTY_BACKOFF_MS);
  }

  /** Prepares one swarm's harness and starts its task workflow. True when a workflow started. */
  private async begin(m: MembershipView): Promise<boolean> {
    this.set('leasing', `Asking ${m.swarm} for a task`);
    const ctl = new AbortController();
    let prepared: Awaited<ReturnType<Deps['memberships']['prepareRun']>>;
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
    const input: SwarmTaskInput = {
      nodeId: this.d.nodeId()!,
      membershipId: m.id,
      swarm: m.swarm,
      permissionsHash: m.permissions_hash,
      harnessHash: prepared.release.bundleHash,
      model: { contentHash: model.contentHash, slug: model.slug, displayName: model.displayName },
      timeoutS: prepared.swarm?.task?.timeoutS ?? 300,
    };
    let started: Awaited<ReturnType<WorkflowEngine['startTask']>>;
    try {
      started = await this.engine.startTask(input);
    } catch (e) {
      this.set('waiting', e instanceof Error ? e.message.slice(0, 200) : 'The local workflow engine did not start the task.');
      return false;
    }
    let settle: (leased: boolean) => void = noop;
    const settled = new Promise<boolean>((r) => (settle = r));
    const c: Current = { workflowId: started.workflowId, input, progress: { leaseId: null, phase: 'leasing', deadlineAt: null, urgent: false }, startedAt: Date.now(), stop: null, ctl: null, resumed: false, settle };
    this.current = c;
    this.follow(c, started.result);
    return settled;
  }

  private onProgress(p: Partial<TaskProgress> & { leaseId: string | null }) {
    const c = this.current;
    if (!c) return;
    const wasRunning = this.view(c) !== null;
    c.progress = { ...c.progress, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) };
    if (c.progress.leaseId) c.settle(true);
    if (!wasRunning && this.view(c)) this.set('running', `${c.resumed ? 'Resuming' : 'Running'} a task for ${c.input.swarm} on ${c.input.model.displayName}`);
    if (p.phase === 'running' && c.resumed) this.set('running', `Running a task for ${c.input.swarm} on ${c.input.model.displayName}`);
    this.d.changed();
  }

  /** Waits for the workflow's outcome, then records it and looks for the next task. */
  private follow(c: Current, result: Promise<TaskOutcome>) {
    this.running = result
      .catch((): TaskOutcome => ({ outcome: 'failed', detail: 'The task workflow stopped unexpectedly. Its lease returns to the queue at its deadline, unpaid.', leaseId: c.progress.leaseId }))
      .then((o) => this.finish(c, o))
      .finally(() => {
        if (this.running && this.current === null) this.running = null;
      });
  }

  private async finish(c: Current, o: TaskOutcome) {
    const elapsedMs = Date.now() - c.startedAt;
    if (this.current === c) this.current = null;
    if (o.outcome === 'no_task') {
      if (o.kill) {
        await this.d.kill?.check();
        this.set('blocked', o.detail);
      } else {
        this.skip(c.input.membershipId);
        this.set('waiting', o.detail);
      }
      this.d.changed();
      c.settle(false);
      return;
    }
    // A stop the user asked for explains itself better than the generic local failure text.
    const detail = c.stop && o.outcome === 'abandoned' && o.code === c.stop.reason ? c.stop.detail : o.detail;
    this.record({ leaseId: o.leaseId ?? '', swarm: c.input.swarm, outcome: o.outcome as TaskHistoryItem['outcome'], detail, elapsedMs });
    if (o.code === 'pin_mismatch') this.skip(c.input.membershipId);
    // Time used is charged to the swarm's share, urgent or not (SPEC 7.1).
    this.scheduler.charge(c.input.membershipId, elapsedMs, c.progress.urgent);
    this.lastHome = Date.now();
    await this.d.memberships.refresh().catch(() => null);
    if (this.d.isPaused()) this.set('paused', this.pausedText());
    else this.set('waiting', 'Looking for the next task.');
    this.d.changed();
    c.settle(true);
    setTimeout(() => void this.tick(), 0);
  }

  /** Builds the sandbox run for a lease. Prepares the harness again after a restart (a cached bundle is reused). */
  private async runSpec(input: SwarmTaskInput, leaseId: string, taskInput: Record<string, unknown>, signal: AbortSignal): Promise<HarnessRunSpec> {
    const home = this.d.memberships.overview().home ?? (await this.d.memberships.refresh());
    const m = home?.joined.find((j) => j.id === input.membershipId);
    if (!m) throw new Error('This node is no longer a member of that swarm.');
    const prepared = await this.d.memberships.prepareRun(m, signal);
    if (prepared.release.bundleHash !== input.harnessHash) throw new Error('The harness changed since the task was leased.');
    return this.d.memberships.runSpec(m, prepared, { contentHash: input.model.contentHash, slug: input.model.slug }, leaseId, taskInput);
  }

  /** Abandon is best effort: if it never arrives, the lease expires at its deadline and requeues. */
  private async abandon(leaseId: string, reason: AbandonReason) {
    try {
      await this.d.auth.signedFetch('POST', `/v1/leases/${leaseId}/abandon`, { reason });
    } catch {
      // Offline or signed out.
    }
  }
}
