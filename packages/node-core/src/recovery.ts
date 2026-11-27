/**
 * Recovery after the node process or its workflow worker was killed (spin-out spec v2, 9.3). The
 * durable engine (Temporal in the node) remembers every task workflow and what each step returned;
 * these pure rules decide what happens to leases when the node comes back. They hold for any
 * engine behind the client's `WorkflowEngine` interface.
 *
 * Exactly once: the lease request is keyed by the workflow id, and the result is sealed (output,
 * hash and signed run record) in one step whose return value the engine journals, then sent with
 * an Idempotency-Key derived from the lease id. A retried submit therefore sends the identical
 * request, which the coordinator replays, and the coordinator also refuses a second result for a
 * lease. See docs/DECISIONS.md "Temporal in the node (2026-11-26)".
 */
import { createHash } from 'node:crypto';

export type OpenLease = { id: string; status: string; deadlineAt: string; swarm: string };
/** An open task workflow. `leaseId` is null while its lease step has not returned yet. */
export type OpenTaskWorkflow = { workflowId: string; leaseId: string | null };

export type RecoveryPlan = {
  /** Workflows to keep: the engine resumes them where they stopped. */
  resume: string[];
  /** Open leases that no workflow owns: return them now, unpaid. */
  abandon: string[];
  /** True when a lease step is still in flight, so orphans are kept until it returns. */
  deferred: boolean;
};

export function planRecovery(open: readonly OpenLease[], workflows: readonly OpenTaskWorkflow[]): RecoveryPlan {
  const owned = new Set(workflows.map((w) => w.leaseId).filter((l): l is string => l !== null));
  // A workflow whose lease step had not returned may be about to adopt a lease the coordinator
  // already granted (its retry replays the same Idempotency-Key). Never abandon under it.
  const deferred = workflows.some((w) => w.leaseId === null);
  return {
    resume: workflows.map((w) => w.workflowId),
    abandon: deferred ? [] : open.filter((l) => !owned.has(l.id)).map((l) => l.id),
    deferred,
  };
}

/**
 * Idempotency keys derived from durable ids, so a retry after a crash repeats the same request.
 * The coordinator accepts 16 to 128 URL-safe characters; a workflow id is hashed to fit.
 */
export const leaseRequestKey = (workflowId: string) => `henge-lease-${createHash('sha256').update(workflowId).digest('base64url')}`;
export const resultSubmitKey = (leaseId: string) => `henge-result-${leaseId}`;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type ResumeStep = 'run' | 'submit';
export type ResumeDecision = { action: 'continue' } | { action: 'renew' } | { action: 'abandon'; reason: 'deadline_passed' };

/**
 * What a resumed step does with its lease. Before the harness has run, a lease past its deadline is
 * abandoned cleanly instead of doing work that cannot count; a lease close to its deadline asks for
 * renewal once (when a fifth is left, as the M5 runner does). A finished result is always sent: the
 * coordinator records it as late and unpaid if the deadline passed, which keeps the record honest.
 */
export function resumeDecision(o: { step: ResumeStep; leasedAt: number; deadlineAt: number; now: number }): ResumeDecision {
  if (o.step === 'submit') return { action: 'continue' };
  if (o.now >= o.deadlineAt) return { action: 'abandon', reason: 'deadline_passed' };
  if (o.deadlineAt - o.now <= (o.deadlineAt - o.leasedAt) / 5) return { action: 'renew' };
  return { action: 'continue' };
}

/** Counts submissions from the coordinator's answers: a replayed or duplicate answer is not a second result. */
export function countSubmissions(answers: ReadonlyArray<{ status: number; duplicate?: boolean; replayed?: boolean }>): { results: number; duplicates: number } {
  let results = 0;
  let duplicates = 0;
  for (const a of answers) {
    if (a.status !== 200 && a.status !== 201) continue;
    if (a.duplicate || a.replayed) duplicates++;
    else results++;
  }
  return { results, duplicates };
}
