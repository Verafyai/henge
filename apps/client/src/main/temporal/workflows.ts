/**
 * Henge node workflows (spin-out spec v2, 9.3), run by the Temporal worker in the main process
 * against the local dev server. Workflow code is deterministic and bundled on its own
 * (scripts/bundle-workflows.mts): it imports only `@temporalio/workflow`, types and the pure step
 * function in task-steps.ts. Every side
 * effect is an activity (activities.ts), whose result Temporal journals, so after a kill the
 * workflow replays to where it stopped and continues without repeating finished steps.
 *
 * - SwarmTaskWorkflow: lease, start, guard, run the harness (heartbeats, lease renewal), seal the
 *   result, submit it once with an Idempotency-Key derived from the lease id.
 * - JoinWorkflow: resolve and validate a `.henge` file, pin it, wait for admission when the
 *   Henge reviews requests, then start its BundleUpdateWorkflow.
 * - BundleUpdateWorkflow: fetch updates on a schedule, diff, hold the node for re-consent when a
 *   `member_reconsent_on` field changed, continue-as-new to keep history short.
 */
import { ActivityFailure, ParentClosePolicy, condition, continueAsNew, defineQuery, defineSignal, proxyActivities, setHandler, sleep, startChild, workflowInfo } from '@temporalio/workflow';
import type { BundleActivities, TaskActivities } from './activities';
import { BUNDLE_CHECK_INTERVAL_MS, CONTINUE_AS_NEW_AFTER_EVENTS, RUN_HEARTBEAT_TIMEOUT_S } from './constants';
import { runSwarmTask } from './task-steps';
import type { BundleUpdateState, HengePinRecord, JoinInput, JoinOutcome, SwarmTaskInput, TaskOutcome, TaskProgress } from './types';

/* Engineering values, not business rules (DECISIONS "Temporal in the node"). */
const SHORT = { startToCloseTimeout: '30 seconds', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '10 seconds', maximumAttempts: 5 } } as const;
const RUN_ATTEMPTS = 3;
const SUBMIT = { startToCloseTimeout: '15 seconds', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 10 } } as const;

export const taskProgressQuery = defineQuery<TaskProgress>('taskProgress');
export const confirmReconsentSignal = defineSignal<[string]>('confirmReconsent');
export const admittedSignal = defineSignal('admitted');
export const hengeStatusQuery = defineQuery<HengePinRecord['status'] | 'resolving' | 'failed'>('hengeStatus');

const short = proxyActivities<TaskActivities>(SHORT);
const submitter = proxyActivities<TaskActivities>(SUBMIT);

function runner(timeoutS: number) {
  return proxyActivities<TaskActivities>({
    startToCloseTimeout: `${Math.max(60, timeoutS + 60)} seconds`,
    heartbeatTimeout: `${RUN_HEARTBEAT_TIMEOUT_S} seconds`,
    retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '5 seconds', maximumAttempts: RUN_ATTEMPTS },
  });
}

export async function SwarmTaskWorkflow(input: SwarmTaskInput): Promise<TaskOutcome> {
  const progress: TaskProgress = { leaseId: null, phase: 'leasing', deadlineAt: null, urgent: false };
  setHandler(taskProgressQuery, () => progress);
  return runSwarmTask({ short, run: runner(input.timeoutS), submit: submitter }, input, workflowInfo().workflowId, progress, (e) => e instanceof ActivityFailure);
}

const bundle = proxyActivities<BundleActivities>(SHORT);

export async function JoinWorkflow(input: JoinInput & { checkIntervalMs?: number }): Promise<JoinOutcome> {
  let status: HengePinRecord['status'] | 'resolving' | 'failed' = 'resolving';
  let admitted = false;
  setHandler(hengeStatusQuery, () => status);
  setHandler(admittedSignal, () => {
    admitted = true;
  });
  const r = await bundle.resolveForJoin(input);
  if (!r.ok) {
    status = 'failed';
    return { ok: false, issues: r.issues };
  }
  const pin = r.pin;
  status = pin.status;
  await bundle.savePin(pin);
  if (pin.status === 'awaiting_admission') {
    // Admission review happens on the community service; it signals `admitted` when accepted.
    await condition(() => admitted);
    await bundle.markAdmitted(pin.id);
    status = 'joined';
  }
  await startChild(BundleUpdateWorkflow, {
    // Hashed by the resolve step: workflow ids are stored unencrypted, so they name no Henge.
    workflowId: r.bundleWorkflowId,
    args: [{ hengeId: pin.id, checks: 0, intervalMs: input.checkIntervalMs ?? BUNDLE_CHECK_INTERVAL_MS }],
    parentClosePolicy: ParentClosePolicy.ABANDON,
  });
  return { ok: true, id: pin.id, status: 'joined' };
}

export async function BundleUpdateWorkflow(state: BundleUpdateState & { intervalMs: number }): Promise<void> {
  let confirmed: string | null = null;
  setHandler(confirmReconsentSignal, (version) => {
    confirmed = version;
  });
  let checks = state.checks;
  for (;;) {
    const c = await bundle.checkBundleUpdate(state.hengeId);
    checks++;
    if (c.kind === 'gone') return;
    if (c.kind === 'update' && c.issues.length === 0) {
      if (c.reconsent.length) {
        // 6.4: a change to a `member_reconsent_on` field pauses the node until the member re-confirms.
        await bundle.holdForReconsent(state.hengeId, c);
        await condition(() => confirmed === c.version);
        confirmed = null;
      }
      await bundle.applyUpdate(state.hengeId, c);
    }
    if (workflowInfo().historyLength > CONTINUE_AS_NEW_AFTER_EVENTS) await continueAsNew<typeof BundleUpdateWorkflow>({ hengeId: state.hengeId, checks, intervalMs: state.intervalMs });
    await sleep(state.intervalMs);
  }
}
