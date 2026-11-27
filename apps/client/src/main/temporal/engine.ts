/**
 * The durable workflow engine behind the task runner (spin-out spec v2, 9.3). `WorkflowEngine` is
 * what the runner needs; `TemporalEngine` implements it with the Temporal TypeScript SDK: a worker
 * in this process (activities need the device key and the supervisor) polling the local dev server
 * the node supervises. The coordinator still sees only the M5 lease protocol.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import type { DataConverter, PayloadCodec } from '@temporalio/common';
import { NativeConnection, Runtime, Worker, type WorkerOptions } from '@temporalio/worker';
import type { BundleActivities, TaskActivities } from './activities';
import type { TemporalDevServer } from './server';
import { runSwarmTask } from './task-steps';
import type { JoinInput, JoinOutcome, SwarmTaskInput, TaskOutcome, TaskProgress } from './types';

export type OpenTask = { workflowId: string; input: SwarmTaskInput; progress: TaskProgress | null; result: Promise<TaskOutcome> };

export interface WorkflowEngine {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Starts one task workflow. The id is durable: a lease request is keyed by it. */
  startTask(input: SwarmTaskInput): Promise<{ workflowId: string; result: Promise<TaskOutcome> }>;
  /** Task workflows still open (for example after a kill), with their journaled progress. */
  openTasks(): Promise<OpenTask[]>;
  joinHenge(input: JoinInput, checkIntervalMs?: number): Promise<{ workflowId: string; result: Promise<JoinOutcome> }>;
  confirmReconsent(hengeId: string, version: string): Promise<void>;
  admitted(joinWorkflowId: string): Promise<void>;
}

export type TemporalEngineOpts = {
  server: TemporalDevServer | { address: string; start(): Promise<void>; stop(): Promise<void> };
  namespace: string;
  taskQueue: string;
  /** Prebuilt bundle in packaged and e2e builds; the source path in tests (bundled on start). */
  workflows: { codePath: string } | { workflowsPath: string };
  activities: TaskActivities & BundleActivities;
  /** Encrypts payloads at rest (codec.ts). Tests that read results with their own client may leave it out. */
  codec?: PayloadCodec;
  log?: (line: string) => void;
};

/** Workflow ids name no Henge in plain text: the id is hashed. */
export const bundleWorkflowId = (hengeId: string) => `henge-bundle-${createHash('sha256').update(hengeId).digest('hex').slice(0, 32)}`;

let runtimeInstalled = false;

export class TemporalEngine implements WorkflowEngine {
  readonly name = 'temporal';
  private client: Client | null = null;
  private connection: Connection | null = null;
  private nativeConnection: NativeConnection | null = null;
  private worker: Worker | null = null;
  private running: Promise<void> | null = null;

  constructor(private o: TemporalEngineOpts) {}

  async start(): Promise<void> {
    if (this.worker) return;
    if (!runtimeInstalled) {
      // Core's own logs go to our log only; no telemetry is exported.
      Runtime.install({ logger: { log: (level, message) => level === 'ERROR' && this.o.log?.(message), trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: (m) => this.o.log?.(m) } });
      runtimeInstalled = true;
    }
    await this.o.server.start();
    this.nativeConnection = await NativeConnection.connect({ address: this.o.server.address });
    this.connection = await Connection.connect({ address: this.o.server.address });
    this.client = new Client({ connection: this.connection, namespace: this.o.namespace, ...(this.dataConverter() ? { dataConverter: this.dataConverter()! } : {}) });
    const opts: WorkerOptions = {
      connection: this.nativeConnection,
      namespace: this.o.namespace,
      taskQueue: this.o.taskQueue,
      activities: this.o.activities,
      // Local GPU concurrency is one task; a few short steps (abandon, bundle checks) may overlap.
      maxConcurrentActivityTaskExecutions: 4,
      ...(this.dataConverter() ? { dataConverter: this.dataConverter()! } : {}),
      ...('codePath' in this.o.workflows ? { workflowBundle: { codePath: this.o.workflows.codePath } } : { workflowsPath: this.o.workflows.workflowsPath }),
    };
    this.worker = await Worker.create(opts);
    this.running = this.worker.run().catch((e: unknown) => this.o.log?.(`Temporal worker stopped: ${String(e)}`));
  }

  private dataConverter(): DataConverter | null {
    if (!this.o.codec) return null;
    return { payloadCodecs: [this.o.codec] };
  }

  async stop(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w && w.getState() === 'RUNNING') w.shutdown();
    await this.running;
    this.running = null;
    await this.nativeConnection?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.nativeConnection = null;
    this.connection = null;
    this.client = null;
    await this.o.server.stop();
  }

  private c(): Client {
    if (!this.client) throw new Error('The local workflow engine is not running.');
    return this.client;
  }

  async startTask(input: SwarmTaskInput) {
    const workflowId = `swarm-task-${input.nodeId}-${randomUUID()}`;
    const h = await this.c().workflow.start('SwarmTaskWorkflow', {
      workflowId,
      taskQueue: this.o.taskQueue,
      args: [input],
      memo: { input },
    });
    return { workflowId, result: h.result() as Promise<TaskOutcome> };
  }

  async openTasks(): Promise<OpenTask[]> {
    try {
      const out = await this.listOpen();
      this.o.log?.(`Open task workflows after start: ${out.length}.`);
      return out;
    } catch (e) {
      this.o.log?.(`Listing open task workflows failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }

  private async listOpen(): Promise<OpenTask[]> {
    const out: OpenTask[] = [];
    for await (const w of this.c().workflow.list({ query: `WorkflowType = 'SwarmTaskWorkflow' AND ExecutionStatus = 'Running'` })) {
      const input = (w.memo as { input?: SwarmTaskInput } | undefined)?.input;
      if (!input) continue;
      const h = this.c().workflow.getHandle(w.workflowId);
      const progress = await h.query<TaskProgress>('taskProgress').catch(() => null);
      out.push({ workflowId: w.workflowId, input, progress, result: h.result() as Promise<TaskOutcome> });
    }
    return out;
  }

  async joinHenge(input: JoinInput, checkIntervalMs?: number) {
    const workflowId = `henge-join-${randomUUID()}`;
    const h = await this.c().workflow.start('JoinWorkflow', { workflowId, taskQueue: this.o.taskQueue, args: [{ ...input, ...(checkIntervalMs ? { checkIntervalMs } : {}) }] });
    return { workflowId, result: h.result() as Promise<JoinOutcome> };
  }

  async confirmReconsent(hengeId: string, version: string) {
    await this.c().workflow.getHandle(bundleWorkflowId(hengeId)).signal('confirmReconsent', version);
  }

  async admitted(joinWorkflowId: string) {
    try {
      await this.c().workflow.getHandle(joinWorkflowId).signal('admitted');
    } catch (e) {
      if (!(e instanceof WorkflowNotFoundError)) throw e;
    }
  }
}

/**
 * Runs the same task steps without durability, in this process: unit tests, and the fallback when
 * the local workflow server cannot start (the node then says so and behaves as in M5, where a
 * crash returns the lease on the next start).
 */
export class InProcessEngine implements WorkflowEngine {
  readonly name = 'in_process';
  private open = new Map<string, OpenTask>();

  constructor(private activities: TaskActivities) {}

  async start() {}
  async stop() {}

  async startTask(input: SwarmTaskInput) {
    const workflowId = `swarm-task-${input.nodeId}-${randomUUID()}`;
    const progress: TaskProgress = { leaseId: null, phase: 'leasing', deadlineAt: null, urgent: false };
    const a = this.activities;
    const result = runSwarmTask({ short: a, run: a, submit: a }, input, workflowId, progress, () => true).finally(() => this.open.delete(workflowId));
    this.open.set(workflowId, { workflowId, input, progress, result });
    return { workflowId, result };
  }

  async openTasks() {
    return [...this.open.values()];
  }

  async joinHenge(): Promise<never> {
    throw new Error('Joining a Henge needs the local workflow engine, which is not running.');
  }

  async confirmReconsent(): Promise<never> {
    throw new Error('The local workflow engine is not running.');
  }

  async admitted() {}
}
