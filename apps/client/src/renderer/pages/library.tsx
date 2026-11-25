import type { MembershipView } from '@swarm-explorer/api-client';
import { formatShare } from '@swarm-explorer/core';
import { Chip } from '@swarm-explorer/ui';
import { useEffect, useState } from 'react';
import { useAuth, useNode, useSwarms } from '../api';
import { useNav } from '../router';
import { Btn, Empty } from '../ui/bits';
import { membershipLabel } from '../view';
import type { MembershipJob } from '../../shared/node';

function Row({ m, name, job }: { m: MembershipView; name: string; job: MembershipJob | null }) {
  const { go } = useNav();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const label = membershipLabel[m.status];
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
      {m.status === 'active' && <p className="mt-2 text-xs text-zinc-600">Qualified. Tasks start when the swarm coordinator is live (milestone M5).</p>}
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
  const mem = node.data?.memberships;
  const joined = mem?.home?.joined ?? [];
  const nameOf = (slug: string) => swarms.data?.find((s) => s.slug === slug)?.name ?? slug;
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
          <p className="mt-1 text-sm text-zinc-600">
            {mem?.home?.node.qualified_swarms
              ? `${mem.home.node.qualified_swarms} qualified, sharing ${formatShare(mem.home.node.share_total_bp)} of this node's time.`
              : 'No swarm has qualified yet.'}
          </p>
          <ul className="mt-4 space-y-3" aria-label="Joined swarms">
            {joined.map((m) => (
              <Row key={m.id} m={m} name={nameOf(m.swarm)} job={mem?.jobs.find((j) => j.membershipId === m.id) ?? null} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
