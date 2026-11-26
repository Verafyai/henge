import { formatShare } from '@swarm-explorer/core';
import { useNode, useNodeActions, useSwarms } from '../api';
import { Btn, Empty } from '../ui/bits';
import { ResultsList } from './results';

const OUTCOME: Record<'submitted' | 'late' | 'abandoned' | 'failed', string> = {
  submitted: 'Submitted',
  late: 'Late, not counted',
  abandoned: 'Abandoned, unpaid',
  failed: 'Failed, unpaid',
};

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const secs = (ms: number) => `${Math.max(0, Math.round(ms / 100) / 10)} s`;

/** Activity (SPEC 4.1, 7.1): what runs now, why nothing runs, this session's timeshare and runs. */
export function ActivityPage() {
  const node = useNode();
  const actions = useNodeActions();
  const swarms = useSwarms();
  const o = node.data;
  const t = o?.tasks;
  const nameOf = (slug: string) => swarms.data?.find((s) => s.slug === slug)?.name ?? slug;
  const joined = o?.memberships.home?.joined ?? [];
  const nameOfMembership = (id: string) => {
    const m = joined.find((j) => j.id === id);
    return m ? nameOf(m.swarm) : 'A swarm you left';
  };
  return (
    <div className="mx-auto max-w-[960px] px-6 py-8">
      <h1 className="text-3xl font-bold">Activity</h1>
      <p className="mt-2 text-zinc-600">What this node is doing, and why. Each result shows where it is in verification and what it really earned.</p>
      {!t ? null : (
        <div className="mt-6 space-y-4">
          <section aria-label="Now" className="rounded-xl border border-zinc-200 p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">Now</h2>
              <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={() => void actions.setPaused(!o!.paused)}>
                {o!.paused ? 'Resume node' : 'Pause node'}
              </Btn>
            </div>
            <p className="mt-1 text-sm" data-testid="task-status">
              {t.current ? `${t.current.phase === 'submitting' ? 'Submitting' : 'Running'} a task for ${nameOf(t.current.swarm)} on ${t.current.model}${t.current.urgent ? ' (urgent)' : ''}.` : t.detail}
            </p>
            {t.current && <p className="mt-1 text-xs text-zinc-500">{`Started ${time.format(new Date(t.current.startedAt))}. The coordinator expects it by ${time.format(new Date(t.current.deadlineAt))}.`}</p>}
            {t.gate && t.gate.blocks.length > 0 && (
              <ul aria-label="Run rules holding work back" className="mt-2 list-disc pl-5 text-xs text-zinc-600">
                {t.gate.blocks.map((b) => (
                  <li key={b.rule}>{b.detail}</li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Timeshare this session" className="rounded-xl border border-zinc-200 p-5">
            <h2 className="font-semibold">Timeshare this session</h2>
            {t.shares.length === 0 ? (
              <p className="mt-1 text-sm text-zinc-600">No task has run yet this session.</p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500">
                    <th className="py-1 font-normal">Swarm</th>
                    <th className="py-1 font-normal">Share</th>
                    <th className="py-1 font-normal">Time used</th>
                    <th className="py-1 font-normal">Urgent</th>
                    <th className="py-1 font-normal">Ahead of share</th>
                  </tr>
                </thead>
                <tbody>
                  {t.shares.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-100">
                      <td className="py-1">{nameOfMembership(s.id)}</td>
                      <td className="py-1">{formatShare(s.shareBp)}</td>
                      <td className="py-1">{secs(s.servedMs)}</td>
                      <td className="py-1">{secs(s.urgentMs)}</td>
                      <td className="py-1">{s.deficitMs > 0 ? secs(s.deficitMs) : 'none'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-zinc-500">A swarm with no tasks lends its time to the others and keeps its share. Urgent tasks run first and count against their swarm’s share.</p>
          </section>

          <section aria-label="Recent tasks" className="rounded-xl border border-zinc-200 p-5">
            <h2 className="font-semibold">Recent tasks this session</h2>
            {t.history.length === 0 ? (
              <Empty className="mt-2" title="No tasks yet this session." />
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {t.history.map((h) => (
                  <li key={`${h.leaseId}-${h.at}`} data-testid="task-history" data-outcome={h.outcome}>
                    <span className="font-semibold">{OUTCOME[h.outcome]}</span>
                    {` ${nameOf(h.swarm)}, ${secs(h.elapsedMs)}, ${time.format(new Date(h.at))}. ${h.detail}`}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Verification" className="rounded-xl border border-zinc-200 p-5">
            <h2 className="font-semibold">Your results</h2>
            <p className="mt-1 text-xs text-zinc-500">The swarm’s state for each result: Submitted, Verifying, Pending, Settled, Rejected or Clawed back.</p>
            <ResultsList limit={10} label="Activity results" />
          </section>
        </div>
      )}
    </div>
  );
}
