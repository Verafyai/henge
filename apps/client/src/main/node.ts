/**
 * Node shell (SPEC 16.4 M1) in the main process: starts the supervisor as a separate utility
 * process, relays detection and pause, keeps first-run choices in the encrypted cache, and
 * registers the install and node with the server using device-signed requests.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, chmodSync, constants, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { capabilitiesAcceptedSchema, createApiClient, registerInstallResponseSchema } from '@swarm-explorer/api-client';
import type { PlatformPublicKey } from '@swarm-explorer/schema/node';
import { describeRunRules, enforcementSupport, minimizeCapabilities, ollamaBaseUrl, recommendMode, type RunRules } from '@swarm-explorer/node-core';
import { nodeSetupSchema, supervisorMessageSchema, type Detection, type HarnessRunResult, type HarnessRunSpec, type NodeOverview, type NodeSetup, type SandboxCheck, type SupervisorCommand, type SupervisorMessage } from '../shared/node';
import type { AuthManager } from './auth';
import type { EncryptedCache } from './cache';
import { KillSwitchWatcher } from './kill-switch';
import { MembershipManager } from './memberships';
import { ModelManager } from './models';
import { readSensors } from './sensors';
import { proxySocketDir, proxySocketPath } from './socket-path';
import { TaskRunner } from './tasks';

type Registration = { installId: string; nodeId: string; capabilitiesReportedAt: number | null };

export type NodeControllerOpts = {
  auth: AuthManager;
  cache: () => EncryptedCache;
  apiBaseUrl: string;
  userDataDir: string;
  appVersion: string;
  channel: string;
  /** Revocation feed keys pinned at build time; null means trust the feed's keys (unpackaged test builds only). */
  revocationKeys: PlatformPublicKey[] | null;
  /** Unpackaged test hooks; main passes them only when the app is not packaged. */
  testHooks: { hardwareFixture?: string; ollamaHost?: string; hfBase?: string; sensorFixture?: string } | null;
};

/** Absolute path of an executable on PATH, without running it. The proxy itself has an empty PATH. */
function onPath(bin: string): string | null {
  const names = process.platform === 'win32' ? [`${bin}.exe`] : [bin];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d)).slice(0, 64)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

export class NodeController extends EventEmitter {
  private child: UtilityProcess | null = null;
  private restarts = 0;
  private nextId = 1;
  private waiting = new Map<number, (d: Detection) => void>();
  private detection: Detection | null = null;
  private paused = false;
  private catalogMinBytes: number | null = null;
  private registering: Promise<void> | null = null;
  /** Replies from the supervisor for install, benchmark and remove, keyed by request id. */
  private replies = new Map<number, { on: (m: SupervisorMessage) => void; fail: (e: Error) => void }>();
  readonly models: ModelManager;
  readonly memberships: MembershipManager;
  readonly tasks: TaskRunner;
  readonly kill: KillSwitchWatcher;
  private proxy: UtilityProcess | null = null;
  private proxyRestarts = 0;
  /** Session capability key shared by the supervisor (mints) and proxy (verifies). Never on disk. */
  private readonly capabilityKey = randomBytes(32).toString('base64url');
  private readonly socketPath: string;

  constructor(private opts: NodeControllerOpts) {
    super();
    this.socketPath = NodeController.socketPathFor(opts.userDataDir);
    const call = <T>(cmd: SupervisorCommand & { id: number }, pick: (m: SupervisorMessage) => T | undefined, onOther?: (m: SupervisorMessage) => void) =>
      new Promise<T>((resolve, reject) => {
        if (!this.child) return reject(new Error('supervisor not running'));
        this.replies.set(cmd.id, {
          on: (m) => {
            const v = pick(m);
            if (v === undefined) return onOther?.(m);
            this.replies.delete(cmd.id);
            resolve(v);
          },
          fail: reject,
        });
        this.send(cmd);
      });
    this.models = new ModelManager({
      auth: opts.auth,
      cache: opts.cache,
      apiBaseUrl: opts.apiBaseUrl,
      detection: () => this.detection,
      nodeId: () => this.registration()?.nodeId ?? null,
      changed: () => this.emit('changed'),
      leasedModel: () => this.tasks?.leasedModel() ?? null,
      rpc: {
        install: (artifact, onProgress) =>
          call(
            { type: 'install', id: this.nextId++, artifact },
            (m) => (m.type === 'installed' ? m.outcome : undefined),
            (m) => m.type === 'progress' && onProgress(m.completed, m.total),
          ),
        benchmark: (runtime, location) => call({ type: 'benchmark', id: this.nextId++, runtime, location }, (m) => (m.type === 'benchmarked' ? { tps: m.tps, detail: m.detail } : undefined)),
        remove: (runtime, location) => call({ type: 'remove', id: this.nextId++, runtime, location }, (m) => (m.type === 'removed' ? m.ok : undefined)),
      },
    });
    this.kill = new KillSwitchWatcher({
      fetchFeed: (signal) => createApiClient({ baseUrl: opts.apiBaseUrl, fetch: (u, init) => fetch(u, { ...init, signal }) }).revocations(),
      pinnedKeys: opts.revocationKeys,
      onChange: () => this.onKillChange(),
    });
    this.memberships = new MembershipManager({
      auth: opts.auth,
      cache: opts.cache,
      apiBaseUrl: opts.apiBaseUrl,
      userDataDir: opts.userDataDir,
      models: this.models,
      nodeId: () => this.registration()?.nodeId ?? null,
      isPaused: () => this.paused,
      changed: () => this.emit('changed'),
      run: (spec, signal) => this.runHarness(spec, signal),
      beforeLeave: (id) => this.tasks.onLeave(id),
      kill: this.kill,
    });
    const support = () => enforcementSupport(this.detection?.hardware.os.platform ?? process.platform);
    this.tasks = new TaskRunner({
      auth: opts.auth,
      cache: opts.cache,
      memberships: this.memberships,
      nodeId: () => this.registration()?.nodeId ?? null,
      isPaused: () => this.paused,
      run: (spec, signal) => this.runHarness(spec, signal),
      sensors: () => readSensors(opts.testHooks?.sensorFixture ?? null),
      get support() {
        return support();
      },
      appVersion: opts.appVersion,
      changed: () => this.emit('changed'),
      kill: this.kill,
    });
  }

  /**
   * A stop or restore arrived on the signed feed (M7): stop the running task and qualification at
   * once and show why; delete the cached harness of every stopped swarm (SPEC 15.2). A restore lets
   * the next pass start work again.
   */
  private onKillChange() {
    const why = this.kill.stoppedReason();
    this.tasks.applyKill();
    if (why) this.memberships.stopAll(why);
    for (const swarm of this.kill.stoppedSwarms()) {
      const reason = this.kill.stoppedReason(swarm)!;
      this.memberships.stopSwarm(swarm, reason);
    }
    this.emit('changed');
  }

  /** A private 0700 socket folder (stale sockets cleared), or a named pipe on Windows (SPEC 11.2). */
  static socketPathFor(userDataDir: string): string {
    const tag = randomBytes(4).toString('hex');
    if (process.platform !== 'win32') {
      const dir = proxySocketDir(userDataDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      for (const f of readdirSync(dir)) if (f.endsWith('.sock')) rmSync(path.join(dir, f), { force: true });
    }
    return proxySocketPath(userDataDir, tag);
  }

  private startProxy() {
    const child = utilityProcess.fork(path.join(__dirname, 'proxy.js'), [], { serviceName: 'Henge model proxy', env: { PATH: '' }, stdio: 'ignore' });
    this.proxy = child;
    const ollama = this.opts.testHooks?.ollamaHost ?? process.env['OLLAMA_HOST'];
    // llama.cpp is the second local source; the proxy starts llama-server itself, by absolute path.
    child.postMessage({ type: 'configure', key: this.capabilityKey, socketPath: this.socketPath, ollamaBase: ollamaBaseUrl({ OLLAMA_HOST: ollama }), llamaServer: onPath('llama-server') });
    this.syncProxyModels();
    child.on('exit', () => {
      this.proxy = null;
      if (this.proxyRestarts++ < 3) setTimeout(() => this.startProxy(), 500 * this.proxyRestarts);
    });
  }

  /** The proxy learns installed models by hash; harnesses only ever name the hash. */
  private syncProxyModels() {
    const list = this.models.installed().map((m) => ({ contentHash: m.contentHash, runtime: m.runtime, ref: m.runtime === 'ollama' ? m.location : m.sourceRef, ...(m.runtime === 'llama_cpp' ? { path: m.location } : {}) }));
    this.proxy?.postMessage({ type: 'models', list });
  }

  /** One sandboxed run in the supervisor. Aborting stops it at once (Leave, Pause). */
  private runHarness(spec: HarnessRunSpec, signal: AbortSignal): Promise<HarnessRunResult> {
    const id = this.nextId++;
    const stopped: HarnessRunResult = { status: 'cancelled', output: null, detail: 'Stopped.', screen: null, modelCalls: 0 };
    return new Promise((resolve) => {
      if (!this.child) return resolve({ ...stopped, status: 'failed', detail: 'The node supervisor is not running.' });
      if (signal.aborted) return resolve(stopped);
      const onAbort = () => this.send({ type: 'harness-cancel', id });
      signal.addEventListener('abort', onAbort, { once: true });
      this.replies.set(id, {
        on: (m) => {
          if (m.type !== 'harness-ran') return;
          this.replies.delete(id);
          signal.removeEventListener('abort', onAbort);
          resolve(m.result);
        },
        fail: () => resolve({ ...stopped, status: 'failed', detail: 'The node supervisor stopped during the run.' }),
      });
      this.send({ type: 'harness-run', id, run: spec });
    });
  }

  async sandboxCheck(): Promise<SandboxCheck[]> {
    const active = this.models.installed().find((m) => m.contentHash === this.models.storage().activeModel);
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (!this.child) return resolve([{ id: 'supervisor', title: 'Node supervisor is running', passed: false, detail: 'Not running.' }]);
      this.replies.set(id, {
        on: (m) => {
          if (m.type !== 'sandbox-checked') return;
          this.replies.delete(id);
          resolve(m.results);
        },
        fail: () => resolve([{ id: 'supervisor', title: 'Node supervisor is running', passed: false, detail: 'It stopped during the checks.' }]),
      });
      this.send({ type: 'sandbox-check', id, activeModel: active ? { contentHash: active.contentHash, modelClass: active.slug } : null });
    });
  }

  start() {
    if (!this.proxy && this.proxyRestarts === 0) {
      this.startProxy();
      this.on('changed', () => this.syncProxyModels());
    }
    // Least privilege: the supervisor gets PATH and its own settings, not this process's environment.
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '',
      SWARM_EXPLORER_DISK_DIR: this.opts.userDataDir,
      SWARM_EXPLORER_MODELS_DIR: path.join(this.opts.userDataDir, 'models'),
    };
    if (this.opts.testHooks?.hfBase) env['SWARM_EXPLORER_HF_BASE'] = this.opts.testHooks.hfBase;
    const ollamaHost = this.opts.testHooks?.ollamaHost ?? process.env['OLLAMA_HOST'];
    if (ollamaHost) env['OLLAMA_HOST'] = ollamaHost;
    if (this.opts.testHooks?.hardwareFixture) env['SWARM_EXPLORER_HARDWARE_FIXTURE'] = this.opts.testHooks.hardwareFixture;
    if (process.platform === 'win32') env['SystemRoot'] = process.env['SystemRoot'] ?? 'C:\\Windows';
    const child = utilityProcess.fork(path.join(__dirname, 'supervisor.js'), [], { serviceName: 'Henge node supervisor', env, stdio: 'ignore' });
    this.child = child;
    child.on('message', (raw: unknown) => this.onMessage(raw));
    child.on('exit', () => {
      this.child = null;
      for (const r of this.waiting.values()) r(this.detection as Detection);
      this.waiting.clear();
      // In-flight model work fails cleanly rather than hanging.
      for (const r of this.replies.values()) r.fail(new Error('The node supervisor stopped.'));
      this.replies.clear();
      if (this.restarts++ < 3) setTimeout(() => this.start(), 500 * this.restarts);
    });
    if (this.paused) this.send({ type: 'pause' });
    this.send({ type: 'sandbox-config', key: this.capabilityKey, socketPath: this.socketPath });
    this.kill.start();
    this.tasks.start();
  }

  stop() {
    this.kill.stop();
    this.tasks.stop();
    this.restarts = Infinity;
    this.proxyRestarts = Infinity;
    this.child?.kill();
    this.proxy?.kill();
  }

  private send(cmd: SupervisorCommand) {
    this.child?.postMessage(cmd);
  }

  private onMessage(raw: unknown) {
    const m = supervisorMessageSchema.safeParse(raw);
    if (!m.success) return; // Malformed messages from the supervisor are dropped.
    if ('id' in m.data && this.replies.has(m.data.id)) return this.replies.get(m.data.id)!.on(m.data);
    if (m.data.type === 'detected') {
      this.detection = m.data.detection;
      this.waiting.get(m.data.id)?.(m.data.detection);
      this.waiting.delete(m.data.id);
      this.emit('changed');
      void this.report();
    } else if (m.data.type === 'paused') {
      this.paused = m.data.paused;
      this.emit('changed');
    }
  }

  async detect(force = false): Promise<Detection | null> {
    if (this.detection && !force) return this.detection;
    if (!this.child) return this.detection;
    const id = this.nextId++;
    const done = new Promise<Detection | null>((resolve) => {
      this.waiting.set(id, resolve);
      setTimeout(() => {
        if (this.waiting.delete(id)) resolve(this.detection);
      }, 30_000);
    });
    this.send({ type: 'detect', id });
    await this.loadCatalogMin();
    return done;
  }

  /**
   * Pause (SPEC 7.2): the supervisor stops the sandbox at once, which hangs up on the model proxy
   * and cancels the model call; the leased task is abandoned unpaid and no new lease starts until
   * Resume. Reachable from the tray, the app menu and the status bar.
   */
  setPaused(paused: boolean) {
    this.paused = paused;
    this.send({ type: paused ? 'pause' : 'resume' });
    if (paused) {
      this.tasks.pause();
      this.memberships.stopAll('Paused. Qualification continues when you resume.');
    } else {
      this.memberships.resumeQualifying();
      this.tasks.resume();
    }
    this.emit('changed');
  }

  setRunRules(r: RunRules) {
    this.tasks.setRules(r);
  }

  get isPaused() {
    return this.paused;
  }

  /** The smallest catalog artifact, used so the GPU check does not invent a threshold (SPEC 5.4). */
  private async loadCatalogMin() {
    if (this.catalogMinBytes !== null) return;
    try {
      const { items } = await createApiClient({ baseUrl: this.opts.apiBaseUrl }).listModels();
      const sizes = items.flatMap((m) => m.artifacts.map((a) => a.sizeBytes));
      this.catalogMinBytes = sizes.length ? Math.min(...sizes) : null;
    } catch {
      this.catalogMinBytes = null; // Offline: any measured dedicated GPU memory counts.
    }
  }

  getSetup(): NodeSetup | null {
    const parsed = nodeSetupSchema.safeParse(this.opts.cache().get('node-setup'));
    return parsed.success ? parsed.data : null;
  }

  saveSetup(s: Omit<NodeSetup, 'completedAt'>): NodeSetup {
    const setup = { ...s, completedAt: Date.now() };
    this.opts.cache().set('node-setup', setup);
    this.emit('changed');
    return setup;
  }

  clearSetup() {
    this.opts.cache().delete('node-setup');
    this.emit('changed');
  }

  private registration(): Registration | null {
    const r = this.opts.cache().get<Registration>('node-registration');
    return r && r.installId === this.opts.auth.installId ? r : null;
  }

  overview(): NodeOverview {
    const d = this.detection;
    const platform = d?.hardware.os.platform ?? process.platform;
    const reg = this.registration();
    return {
      detection: d,
      recommendation: d ? recommendMode(d.hardware, { minVramBytes: this.catalogMinBytes }) : null,
      runRules: describeRunRules(this.tasks.rules(), enforcementSupport(platform)),
      rules: this.tasks.rules(),
      support: enforcementSupport(platform),
      setup: this.getSetup(),
      paused: this.paused,
      registration: reg ? { nodeId: reg.nodeId, capabilitiesReportedAt: reg.capabilitiesReportedAt } : null,
      catalogMinBytes: this.catalogMinBytes,
      models: this.models.overview(),
      memberships: this.memberships.overview(),
      tasks: this.tasks.overview(),
      kill: this.kill.view((this.memberships.overview().home?.joined ?? []).map((m) => m.swarm)),
    };
  }

  /** Registers the install and node (POST /v1/installs), then reports capabilities. Safe to call often. */
  report(): Promise<void> {
    this.registering ??= this.doReport().finally(() => {
      this.registering = null;
    });
    return this.registering;
  }

  private async doReport() {
    const auth = this.opts.auth;
    if (auth.getState().status !== 'signed_in' || !auth.installId) return;
    try {
      await this.registerAndReport();
    } finally {
      await this.models.share();
      await this.memberships.refresh();
    }
  }

  private async registerAndReport() {
    const auth = this.opts.auth;
    try {
      let reg = this.registration();
      if (!reg) {
        const res = await auth.signedFetch('POST', '/v1/installs', {
          app_version: this.opts.appVersion,
          channel: this.opts.channel,
          platform: process.platform,
          arch: process.arch,
        });
        const body = registerInstallResponseSchema.safeParse(await res.json().catch(() => null));
        if (!res.ok || !body.success) return;
        reg = { installId: body.data.install_id, nodeId: body.data.node_id, capabilitiesReportedAt: null };
        this.opts.cache().set('node-registration', reg);
        this.emit('changed');
      }
      const d = this.detection;
      if (!d || (reg.capabilitiesReportedAt && reg.capabilitiesReportedAt >= d.detectedAt)) return;
      const report = minimizeCapabilities(d.hardware, enforcementSupport(d.hardware.os.platform));
      const res = await auth.signedFetch('PUT', `/v1/nodes/${reg.nodeId}/capabilities`, report);
      if (res.status === 404) {
        // The server no longer knows this node (for example after a reset): register again next time.
        this.opts.cache().delete('node-registration');
        return;
      }
      if (!res.ok || !capabilitiesAcceptedSchema.safeParse(await res.json().catch(() => null)).success) return;
      this.opts.cache().set('node-registration', { ...reg, capabilitiesReportedAt: Date.now() });
      this.emit('changed');
    } catch {
      // Offline or signed out; the next launch or sign in tries again.
    }
  }
}
