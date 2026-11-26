import type { ResultItem, ResultState } from '@swarm-explorer/api-client';
import { useState } from 'react';
import type { ReceiptView } from '../../shared/bridge';
import { useResults } from '../api';
import { Btn, Empty } from '../ui/bits';

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
          {r.state === 'settled' && <Receipt resultId={r.result_id} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * The signed receipt for a settled result (M7): fetched and checked in the main process, shown here,
 * and saved as a file anyone can verify offline. Volunteer receipts show impact, never credits.
 */
function Receipt({ resultId }: { resultId: string }) {
  const [view, setView] = useState<ReceiptView | null | 'loading' | 'missing'>(null);
  const [saved, setSaved] = useState<string | null>(null);
  if (view === null)
    return (
      <Btn
        variant="quiet"
        className="mt-2 px-2 py-1 text-xs"
        onClick={() => {
          setView('loading');
          void window.swarm.account.receipt(resultId).then((v) => setView(v ?? 'missing'));
        }}
      >
        View receipt
      </Btn>
    );
  if (view === 'loading') return <p className="mt-2 text-xs text-zinc-500">Fetching the signed receipt</p>;
  if (view === 'missing') return <p className="mt-2 text-xs text-zinc-500">The receipt could not be fetched right now.</p>;
  const rc = view.receipt;
  return (
    <section aria-label="Receipt" data-testid="receipt" data-verified={String(view.verified)} className="mt-2 rounded border border-zinc-200 p-2 text-xs">
      <p className="font-semibold">{view.verified ? 'Receipt, signature checked' : 'Receipt, not verified'}</p>
      <p className="text-zinc-600">{view.detail}</p>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-zinc-600">
        <dt>Receipt</dt>
        <dd className="font-mono break-all">{rc.receipt_id}</dd>
        <dt>Settled</dt>
        <dd>{time.format(new Date(rc.timeline.settled_at))}</dd>
        <dt>Checked by</dt>
        <dd>{rc.verification.map((v) => v.method).join(', ')}</dd>
        <dt>Earned</dt>
        <dd data-testid="receipt-earned">{rc.earned.credits === null ? `${rc.earned.impact_units} impact` : `${rc.earned.impact_units} impact, ${rc.earned.credits} credits`}</dd>
        <dt>Output hash</dt>
        <dd className="font-mono break-all">{rc.result.output_sha256}</dd>
        <dt>Signed by</dt>
        <dd className="font-mono break-all">{rc.signer.key_id}</dd>
      </dl>
      <div className="mt-2 flex items-center gap-2">
        <Btn variant="quiet" className="px-2 py-1 text-xs" onClick={() => void window.swarm.account.saveReceipt(resultId).then((r) => setSaved(r.saved ? r.path : null))}>
          Save receipt
        </Btn>
        {saved && <span data-testid="receipt-saved">{`Saved to ${saved}`}</span>}
      </div>
      <p className="mt-1 text-zinc-500">Anyone can check a saved receipt offline with: swarm receipt verify &lt;file&gt;</p>
    </section>
  );
}
