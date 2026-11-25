import type { MembershipView } from '@swarm-explorer/api-client';
import { formatShare } from '@swarm-explorer/core';
import { Chip } from '@swarm-explorer/ui';
import { useEffect, useState } from 'react';
import { useAuth, useNode, useSwarms } from '../api';
import { useNav } from '../router';
import { Btn, Empty } from '../ui/bits';
import { swarmLabel } from '../view';
import type { MembershipJob } from '../../shared/node';

const QUALIFIED = ['active', 'paused', 'reconsent_required'];

/**
 * Timeshare editor (SPEC 7.1): percentages of this node's time per qualified swarm, saved as basis
 * points that must add up to 10,000.
 */
function SharesEditor({ qualified, nameOf, onDone }: { qualified: MembershipView[]; nameOf: (slug: string) => string; onDone: () => void }) {
  const [pct, setPct] = useState<Record<string, string>>(() => Object.fromEntries(qualified.map((m) => [m.id, (m.share_bp / 100).toFixed(2).replace(/\.?0+$/, '')])));
  const [msg, setMsg] = useState<string | null>(null);
  const bp = qualified.map((m) => ({ membershipId: m.id, shareBp: Math.round(Number(pct[m.id] ?? 0) * 100) }));
  const total = bp.reduce((a, x) => a + (Number.isFinite(x.shareBp) ? x.shareBp : 0), 0);
  const save = async () => {
    if (bp.some((x) => !Number.isInteger(x.shareBp) || x.shareBp < 0 || x.shareBp > 10_000) || total !== 10_000) return setMsg('Shares must add up to 100%.');
    const r = await window.swarm.swarms.setShares(bp);
    if (!r.ok) return setMsg(r.message);
    onDone();
  };
  return (
    <section aria-label="Change shares" className="mt-3 rounded-xl border border-zinc-200 bg-surface p-4 text-sm">
      <ul className="space-y-2">
        {qualified.map((m) => (
          <li key={m.id} className="flex items-center gap-2">
            <label className="flex-1" htmlFor={`share-${m.id}`}>
              {nameOf(m.swarm)}
            </label>
            <input
              id={`share-${m.id}`}
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={pct[m.id] ?? '0'}
              onChange={(e) => setPct({ ...pct, [m.id]: e.target.value })}
              className="w-24 rounded border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-right"
            />
            %
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-zinc-600">{`Total ${formatShare(total)}. A swarm with no tasks lends its time to the others; its share stays as you set it.`}</p>
      <div className="mt-2 flex gap-2">
        <Btn className="px-3 py-1.5 text-sm" onClick={() => void save()}>
          Save shares
        </Btn>
        <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={onDone}>
          Cancel
        </Btn>
      </div>
      {msg && (
        <p role="alert" className="mt-2 text-red-700">
          {msg}
        </p>
      )}
    </section>
  );
}

function Row({ m, name, job, running }: { m: MembershipView; name: string; job: MembershipJob | null; running: string | null }) {
  const { go } = useNav();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const label = swarmLabel(m, running);
  const q = m.qualification;

  const leave = async () => {
    setBusy(true);
    const r = await window.swarm.swarms.leave(m.id);
    setBusy(false);
    if (!r.ok) setMsg(r.message);
  };
  const retry = async () => {
    const r = await window.swarm.swarms.retry(m.id);
    if (!r.ok) setMsg(r.message);
  };

  return (
    <li aria-label={name} className="rounded-xl border border-zinc-200 bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button type="button" className="text-lg font-bold text-ink hover:text-brand" onClick={() => go({ name: 'swarm', slug: m.swarm })}>
            {name}
          </button>
          <Chip tone={label.tone}>{label.text}</Chip>
        </div>
        <span className="text-sm font-semibold text-ink" data-testid="share">
          {`${formatShare(m.share_bp)} of this node's time`}
        </span>
      </div>
      <p className="mt-1 break-all text-xs text-zinc-500">{`Harness ${m.harness.name} ${m.harness.version}, pinned to ${m.harness.hash.slice(0, 19)}`}</p>
      {q && m.status === 'qualifying' && (
        <p className="mt-2 text-sm text-zinc-700" data-testid="qualification">
          {q.outcome === 'failed'
            ? q.retry_reason
            : `Qualification: ${q.passed} of ${q.attempts} known answers matched so far. Needs ${q.pass} of ${q.tasks}.`}
        </p>
      )}
      {job && job.phase !== 'done' && (
        <p className="mt-1 text-xs text-zinc-600" data-testid="job">
          {job.detail}
        </p>
      )}
      {m.status === 'active' && (
        <p className="mt-2 text-xs text-zinc-600" data-testid="queue">
          {m.queue && m.queue.queued > 0
            ? `Qualified. Tasks run when your run rules allow${m.queue.urgent ? `; ${m.queue.urgent} urgent` : ''}. Volunteer work earns impact, not credits.`
            : 'Qualified. No tasks are waiting at the coordinator right now.'}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {m.status === 'reconsent_required' && (
          <Btn className="px-3 py-1.5 text-sm" onClick={() => go({ name: 'reconsent', membershipId: m.id })}>
            Review new permissions
          </Btn>
        )}
        {m.status === 'joining' && (
          <Btn className="px-3 py-1.5 text-sm" onClick={() => go({ name: 'join', slug: m.swarm })}>
            Finish joining
          </Btn>
        )}
        {m.status === 'qualifying' && (!job || job.phase === 'error' || job.phase === 'stopped') && (
          <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={() => void retry()}>
            {q?.outcome === 'failed' ? 'Try qualification again' : 'Continue qualification'}
          </Btn>
        )}
        {confirm ? (
          <>
            <Btn className="bg-danger px-3 py-1.5 text-sm hover:bg-danger-hover" disabled={busy} onClick={() => void leave()}>
              Leave now
            </Btn>
            <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={() => setConfirm(false)}>
              Stay
            </Btn>
            <span className="self-center text-xs text-zinc-600">Stops its work at once and deletes its working space. Credits you earned stay.</span>
          </>
        ) : (
          <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={() => setConfirm(true)}>
            Leave
          </Btn>
        )}
      </div>
      {msg && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {msg}
        </p>
      )}
    </li>
  );
}

/** Library, Your swarms (SPEC 4.2): shares, status, pins, per-swarm leave. Shares of qualified swarms sum to 100%. */
export function LibraryPage() {
  const node = useNode();
  const auth = useAuth();
  const swarms = useSwarms();
  const { go } = useNav();
  useEffect(() => {
    void window.swarm.swarms.refresh();
  }, []);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const mem = node.data?.memberships;
  const joined = mem?.home?.joined ?? [];
  const qualified = joined.filter((j) => QUALIFIED.includes(j.status));
  const running = node.data?.tasks.current?.swarm ?? null;
  const nameOf = (slug: string) => swarms.data?.find((s) => s.slug === slug)?.name ?? slug;
  const ask = (mem?.askEqualize ?? []).map((id) => joined.find((j) => j.id === id)).filter((j): j is MembershipView => Boolean(j));
  const equalize = async () => {
    const r = await window.swarm.swarms.equalize();
    setMsg(r.ok ? null : r.message);
  };
  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <h1 className="text-2xl font-bold">Your swarms</h1>
      {auth.status !== 'signed_in' ? (
        <Empty className="mt-4" title="Sign in to see your swarms." />
      ) : joined.length === 0 ? (
        <Empty className="mt-4" title="You have not joined a swarm yet.">
          <Btn variant="quiet" className="mt-2 px-3 py-1.5 text-sm" onClick={() => go({ name: 'store' })}>
            Browse the Store
          </Btn>
        </Empty>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
            <p>
              {mem?.home?.node.qualified_swarms
                ? `${mem.home.node.qualified_swarms} qualified, sharing ${formatShare(mem.home.node.share_total_bp)} of this node's time${mem.home.node.shares_customized ? ' (your custom shares)' : ' equally'}.`
                : 'No swarm has qualified yet.'}
            </p>
            {qualified.length > 1 && !editing && (
              <>
                <Btn variant="quiet" className="px-3 py-1 text-xs" onClick={() => setEditing(true)}>
                  Change shares
                </Btn>
                {mem?.home?.node.shares_customized && (
                  <Btn variant="quiet" className="px-3 py-1 text-xs" onClick={() => void equalize()}>
                    Share equally
                  </Btn>
                )}
              </>
            )}
          </div>
          {ask.length > 0 && (
            <section aria-label="New swarm share" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p>{`You set custom shares, so ${ask.map((a) => nameOf(a.swarm)).join(' and ')} joined at 0%. ${ask.length === 1 ? 'It runs' : 'They run'} only when your other swarms have no tasks. Share time equally instead?`}</p>
              <div className="mt-2 flex gap-2">
                <Btn className="px-3 py-1.5 text-sm" onClick={() => void equalize()}>
                  Share equally
                </Btn>
                <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={() => void window.swarm.swarms.keepShares()}>
                  Keep my shares
                </Btn>
              </div>
            </section>
          )}
          {editing && <SharesEditor qualified={qualified} nameOf={nameOf} onDone={() => setEditing(false)} />}
          {msg && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {msg}
            </p>
          )}
          <ul className="mt-4 space-y-3" aria-label="Joined swarms">
            {joined.map((m) => (
              <Row key={m.id} m={m} name={nameOf(m.swarm)} job={mem?.jobs.find((j) => j.membershipId === m.id) ?? null} running={running} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
