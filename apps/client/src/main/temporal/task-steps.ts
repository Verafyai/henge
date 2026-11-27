/**
 * The steps of one swarm task (spin-out spec v2, 9.3), written once for every engine behind
 * `WorkflowEngine`. Temporal runs it as SwarmTaskWorkflow, where each `acts` call is a journaled
 * activity; the in-process engine (tests, and a node whose local server cannot start) calls the
 * activities directly. Deterministic: it uses only its arguments, so it is safe in workflow code.
 */
import type { TaskActivities } from './activities';
import type { SwarmTaskInput, TaskOutcome, TaskProgress } from './types';

export type TaskStepActs = {
  short: Pick<TaskActivities, 'leaseTask' | 'startLease' | 'guard' | 'sealResult' | 'abandonLease'>;
  run: Pick<TaskActivities, 'runHarness'>;
  submit: Pick<TaskActivities, 'submitResult'>;
};

export async function runSwarmTask(acts: TaskStepActs, input: SwarmTaskInput, workflowId: string, progress: TaskProgress, isActivityFailure: (e: unknown) => boolean): Promise<TaskOutcome> {
  const short = acts.short;
  const done = (o: TaskOutcome): TaskOutcome => {
    progress.phase = 'done';
    return o;
  };

  const l = await short.leaseTask(input, workflowId);
  if (l.kind === 'none') return done({ outcome: 'no_task', detail: l.message, leaseId: null, code: l.code, kill: l.kill });
  const lease = l.lease;
  progress.leaseId = lease.leaseId;
  progress.deadlineAt = lease.deadlineAt;
  progress.urgent = lease.urgent;
  progress.phase = 'starting';
  const abandon = async (reason: Parameters<TaskActivities['abandonLease']>[1]) => {
    try {
      await short.abandonLease(lease.leaseId, reason);
    } catch {
      // Best effort: an abandon that never arrives expires at the deadline and requeues.
    }
  };

  // The node checks the pins itself before it runs anything (SPEC 7.3).
  if (lease.swarm !== input.swarm || lease.harnessHash !== input.harnessHash || lease.permissionsHash !== input.permissionsHash) {
    await abandon('pin_mismatch');
    return done({ outcome: 'abandoned', detail: 'The harness or permissions did not match. The task went back to the queue, unpaid.', leaseId: lease.leaseId, code: 'pin_mismatch' });
  }

  const s = await short.startLease(input, lease);
  if (!s.ok) {
    if (s.abandon) await abandon(s.code === 'pin_mismatch' ? 'pin_mismatch' : 'local_failure');
    return done({ outcome: s.code === 'input_hash_mismatch' ? 'failed' : 'abandoned', detail: s.message, leaseId: lease.leaseId, code: s.code, kill: s.kill });
  }
  progress.deadlineAt = s.deadlineAt;

  const g = await short.guard(input, lease.leaseId);
  if (!g.ok) {
    await abandon(g.reason);
    return done({ outcome: 'abandoned', detail: g.detail, leaseId: lease.leaseId, code: g.reason });
  }

  progress.phase = 'running';
  let r: Awaited<ReturnType<TaskActivities['runHarness']>>;
  try {
    r = await acts.run.runHarness(input, lease, s.input, s.deadlineAt);
  } catch (e) {
    if (!isActivityFailure(e)) throw e;
    await abandon('local_failure');
    return done({ outcome: 'abandoned', detail: 'The task could not run here. It went back to the queue, unpaid.', leaseId: lease.leaseId, code: 'run_failed' });
  }
  if (r.status === 'stopped') {
    await abandon(r.reason);
    return done({ outcome: 'abandoned', detail: r.detail, leaseId: lease.leaseId, code: r.reason });
  }
  if (r.status === 'expired') {
    await abandon('local_failure');
    return done({ outcome: 'abandoned', detail: r.detail, leaseId: lease.leaseId, code: 'deadline_passed' });
  }
  if (r.status === 'failed') {
    await abandon('local_failure');
    return done({ outcome: 'failed', detail: r.detail, leaseId: lease.leaseId, code: 'run_failed' });
  }

  progress.phase = 'submitting';
  // Sealed once: the journaled body is what every submit attempt sends.
  const sealed = await short.sealResult(input, lease, r);
  const sub = await acts.submit.submitResult(lease.leaseId, sealed);
  if (!sub.ok) return done({ outcome: 'failed', detail: sub.message, leaseId: lease.leaseId, code: sub.code });
  return done(
    sub.disposition === 'on_time'
      ? { outcome: 'submitted', detail: 'Submitted. It waits for the swarm to verify it.', leaseId: lease.leaseId, duplicate: sub.duplicate || sub.replayed }
      : { outcome: 'late', detail: 'Submitted after the lease ended, so it is recorded but not counted.', leaseId: lease.leaseId, duplicate: sub.duplicate || sub.replayed },
  );
}
