import type { ResultItem, ResultState } from '@swarm-explorer/api-client';
import { useResults } from '../api';
import { Empty } from '../ui/bits';

/** The server's state for each result (SPEC 8). Never more than is real. */
export const RESULT_STATE: Record<ResultState, string> = {
  submitted: 'Submitted',
  verifying: 'Verifying',
  pending: 'Pending',
  settled: 'Settled',
  rejected: 'Rejected',
  clawed_back: 'Clawed back',
  not_counted: 'Not counted',
};

const STATE_HELP: Record<ResultState, string> = {
  submitted: 'Received. Format and signature checks come next.',
  verifying: 'The swarm’s verifier is checking it.',
  pending: 'Accepted. It can still be reviewed until the review window closes.',
  settled: 'Final.',
  rejected: 'The verifier did not accept it.',
  clawed_back: 'Found invalid during review. Its impact was removed.',
  not_counted: 'Arrived late or after the task was given up. Recorded, never counted.',
};

const time = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** What a result really earned: impact for volunteer work, credits only for funded work. */
export function earned(r: ResultItem): string {
  const parts: string[] = [];
  if (r.impact) parts.push(`${r.impact.units} impact${r.impact.status === 'pending' ? ', pending' : r.impact.status === 'revoked' ? ', removed' : ''}`);
  if (r.funded && r.credits) parts.push(`${r.credits.amount} credits${r.credits.status === 'pending' ? ', pending' : r.credits.status === 'clawed_back' ? ', returned to the pool' : ''}`);
  return parts.length ? parts.join(' · ') : 'Nothing earned';
}

export function ResultsList({ limit, label = 'Results' }: { limit?: number; label?: string }) {
  const q = useResults();
  if (q.data === null) return <p className="mt-2 text-sm text-zinc-600">Sign in and connect to see your results.</p>;
  const items = (q.data ?? []).slice(0, limit);
  if (items.length === 0) return <Empty className="mt-2" title="No results yet." />;
  return (
    <ul aria-label={label} className="mt-2 space-y-2 text-sm">
      {items.map((r) => (
        <li key={r.result_id} data-testid="result" data-state={r.state} className="rounded-lg border border-zinc-100 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span>
              <span className="font-semibold" data-testid="result-state">
                {RESULT_STATE[r.state]}
              </span>
              {` ${r.swarm_name}`}
            </span>
            <span className="text-xs text-zinc-600" data-testid="result-earned">
              {earned(r)}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">{STATE_HELP[r.state]}</p>
          <ol aria-label="Verification timeline" className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-500">
            {r.timeline.map((t) => (
              <li key={t.state}>{`${RESULT_STATE[t.state]} ${time.format(new Date(t.at))}`}</li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}
