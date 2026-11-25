import type { JoinStarted, SwarmDetail } from '@swarm-explorer/api-client';
import { categoryLabel } from '@swarm-explorer/core';
import { Chip } from '@swarm-explorer/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth, useNode, useRecordView, useSwarm } from '../api';
import { useNav } from '../router';
import { Btn, Empty, Eyebrow } from '../ui/bits';
import { membershipLabel, permissionLines, swarmQuestions } from '../view';

/** The six swarm-page questions in source order (SPEC 4.2), the same content as the website. */
export function SwarmQuestions({ s }: { s: SwarmDetail }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {swarmQuestions(s).map((q) => (
        <section key={q.id} aria-labelledby={`q-${q.id}`} data-question={q.id} className="rounded-xl border border-zinc-200 bg-surface p-4">
          <h2 id={`q-${q.id}`} className="text-sm font-bold text-ink">
            {q.question}
          </h2>
          {q.facts.length > 0 && (
            <dl className="mt-2 space-y-1 text-sm">
              {q.facts.map((f) => (
                <div key={f.label} className="flex justify-between gap-4">
                  <dt className="text-zinc-500">{f.label}</dt>
                  <dd className="text-right text-ink">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {q.items.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink">
              {q.items.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {q.note && <p className="mt-2 text-xs text-zinc-600">{q.note}</p>}
        </section>
      ))}
    </div>
  );
}

function Header({ s, children }: { s: SwarmDetail; children?: ReactNode }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="info">{categoryLabel(s.category)}</Chip>
        <Chip tone={s.funding.mode === 'funded' ? 'approved' : 'neutral'}>{s.funding.mode === 'funded' ? 'Funded' : 'Volunteer'}</Chip>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">Example data</span>
        {children}
      </div>
      <h1 className="mt-3 text-3xl font-bold">{s.name}</h1>
      <p className="text-sm text-zinc-500">by {s.publisher.name}</p>
    </>
  );
}

/** The membership for this swarm on this node, if any. */
function useMembership(slug: string) {
  const node = useNode();
  const m = node.data?.memberships.home?.joined.find((j) => j.swarm === slug) ?? null;
  const job = m ? (node.data?.memberships.jobs.find((j) => j.membershipId === m.id) ?? null) : null;
  return { m, job };
}

/** Swarm page (SPEC 4.2): six questions, then Join. Joining always goes through the permission review. */
export function SwarmPage({ slug }: { slug: string }) {
  const q = useSwarm(slug);
  const record = useRecordView();
  const { go } = useNav();
  const { m } = useMembership(slug);
  const ok = q.isSuccess;
  useEffect(() => {
    if (ok) void record(slug);
    // Record once per successful load of this slug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, slug]);

  if (q.isPending) return <p className="p-6 text-sm text-zinc-500">Loading swarm</p>;
  if (q.isError || !q.data)
    return (
      <div className="p-6">
        <Empty title="This swarm is not available.">It may be unlisted, or the catalog is offline.</Empty>
      </div>
    );
  const s = q.data;
  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <Header s={s}>{m && <Chip tone={membershipLabel[m.status].tone}>{membershipLabel[m.status].text}</Chip>}</Header>
      <div className="mt-4 flex gap-3">
        {m ? (
          <Btn className="px-4 py-2 text-sm" onClick={() => go({ name: 'library' })}>
            Open in Your swarms
          </Btn>
        ) : (
          <Btn className="px-4 py-2 text-sm" onClick={() => go({ name: 'join', slug })}>
            Join
          </Btn>
        )}
      </div>
      <div className="mt-6">
        <SwarmQuestions s={s} />
      </div>
      <p className="mt-4 break-all font-mono text-[11px] text-zinc-500">Manifest {s.release.manifestHash}</p>
    </div>
  );
}

function PermissionReview({ join, swarm }: { join: JoinStarted; swarm: SwarmDetail }) {
  const p = join.permissions;
  return (
    <section aria-label="Join permissions" className="mt-4 rounded-xl border border-zinc-200 bg-surface p-4">
      <Eyebrow>What you are approving</Eyebrow>
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="font-semibold text-ink">Model</dt>
          <dd className="text-zinc-700">
            {join.models.map((m) => `${m.display_name} (license ${m.license_id})`).join(', ')}. Model calls go only through the local proxy.
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">Network</dt>
          <dd className="text-zinc-700">{p.network.length ? `Can reach ${p.network.join(', ')} and nothing else` : 'No network access'}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">Working space</dt>
          <dd className="text-zinc-700">{permissionLines(p).find((l) => l.startsWith('Up to')) ?? 'None'}. Removed when you leave.</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">GPU compute</dt>
          <dd className="text-zinc-700">{p.gpuCompute ? 'Runs GPU work beyond model inference. Approve only if you accept that.' : 'Model inference only'}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">API spend</dt>
          <dd className="text-zinc-700">{p.apiSpendDailyUsd === null ? 'None. This node runs local models only.' : `Up to $${p.apiSpendDailyUsd} a day, within your caps`}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">Harness</dt>
          <dd className="break-all text-zinc-700">
            {swarm.harness.name} {swarm.harness.version}, signed and reviewed. <span className="font-mono text-[11px]">{swarm.release.harnessHash}</span>
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">Qualification</dt>
          <dd className="text-zinc-700">{`Match ${join.qualification.pass} of ${join.qualification.tasks} known answers on your own model. It is not paid work.`}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Join (SPEC 3.2, 4.2 Join permissions). Reached from Join or from henge://join/{swarm}. Opening it
 * changes nothing: the server is asked only when the user chooses to review permissions.
 */
export function JoinReview({ slug }: { slug: string }) {
  const q = useSwarm(slug);
  const auth = useAuth();
  const node = useNode();
  const { go } = useNav();
  const { m, job } = useMembership(slug);
  const [review, setReview] = useState<{ join: JoinStarted; swarm: SwarmDetail } | null>(null);
  const [gpuOk, setGpuOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await window.swarm.swarms.startJoin(slug);
    setBusy(false);
    if (r.ok) setReview({ join: r.join, swarm: r.swarm });
    else setError(r.message);
  };
  const approve = async () => {
    if (!review) return;
    setBusy(true);
    const r = await window.swarm.swarms.approve(review.join.membership.id, review.join.permissions_hash);
    setBusy(false);
    if (!r.ok) setError(r.message);
    else setReview(null);
  };

  const s = q.data;
  return (
    <div className="mx-auto max-w-[760px] px-6 py-8">
      {s && <Header s={s} />}
      <h2 className="mt-4 text-xl font-bold">{m && m.status !== 'joining' ? 'Joining' : 'Review before joining'}</h2>

      {auth.status !== 'signed_in' ? (
        <Empty className="mt-3" title="Sign in to join a swarm.">Nothing has been joined, downloaded or run.</Empty>
      ) : !node.data?.registration ? (
        <Empty className="mt-3" title="Your node is not registered yet.">Finish setup in Pick a cause, then try again.</Empty>
      ) : m && m.status !== 'joining' ? (
        <section aria-label="Qualification" className="mt-3 rounded-xl border border-zinc-200 bg-surface p-4">
          <p className="text-sm font-semibold text-ink" data-testid="join-status">
            {membershipLabel[m.status].text}
          </p>
          {m.qualification && (
            <p className="mt-1 text-sm text-zinc-700" data-testid="qualification-progress">
              {`${m.qualification.passed} of ${m.qualification.attempts} known answers matched so far. Needs ${m.qualification.pass} of ${m.qualification.tasks}.`}
            </p>
          )}
          {job && <p className="mt-1 text-xs text-zinc-600" data-testid="join-job">{job.detail}</p>}
          <Btn variant="quiet" className="mt-3 px-3 py-1.5 text-sm" onClick={() => go({ name: 'library' })}>
            Go to Your swarms
          </Btn>
        </section>
      ) : review ? (
        <>
          <PermissionReview join={review.join} swarm={review.swarm} />
          {review.join.permissions.gpuCompute && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={gpuOk} onChange={(e) => setGpuOk(e.target.checked)} /> I approve GPU compute beyond model inference
            </label>
          )}
          <div className="mt-4 flex gap-3">
            <Btn className="px-4 py-2 text-sm" disabled={busy || (review.join.permissions.gpuCompute && !gpuOk)} onClick={() => void approve()}>
              Approve and qualify
            </Btn>
            <Btn variant="quiet" className="px-4 py-2 text-sm" onClick={() => go({ name: 'swarm', slug })}>
              Not now
            </Btn>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-zinc-600">
            {s ? `Joining ${s.name} installs its signed harness and runs it in the sandbox with your own model.` : 'Joining installs a signed harness.'} Nothing has
            been joined, downloaded or run yet.
          </p>
          <Btn className="mt-4 px-4 py-2 text-sm" disabled={busy} onClick={() => void start()}>
            Review permissions
          </Btn>
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
          {/model/i.test(error) && (
            <Btn variant="quiet" className="ml-2 px-2 py-0.5 text-xs" onClick={() => go({ name: 'models' })}>
              Models
            </Btn>
          )}
        </p>
      )}
    </div>
  );
}

/** A new release changed the permissions (SPEC 11.4). Work stays stopped until they are approved. */
export function ReconsentPage({ membershipId }: { membershipId: string }) {
  const { go } = useNav();
  const [state, setState] = useState<Awaited<ReturnType<typeof window.swarm.swarms.reviewChange>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.swarm.swarms.reviewChange(membershipId).then(setState);
  }, [membershipId]);
  if (!state) return <p className="p-6 text-sm text-zinc-500">Loading the new permissions</p>;
  if (!state.ok)
    return (
      <div className="p-6">
        <Empty title="Nothing to review.">{state.message}</Empty>
      </div>
    );
  const before = state.previous ? permissionLines(state.previous) : [];
  const after = permissionLines(state.swarm.permissions);
  const approve = async () => {
    setBusy(true);
    const r = await window.swarm.swarms.approve(membershipId, state.swarm.release.permissionsHash);
    setBusy(false);
    if (r.ok) go({ name: 'library' });
    else setError(r.message);
  };
  return (
    <div className="mx-auto max-w-[760px] px-6 py-8">
      <h1 className="text-2xl font-bold">{state.swarm.name} changed its permissions</h1>
      <p className="mt-2 text-zinc-600">Work for this swarm is stopped until you approve the new set. You can also leave it.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section aria-label="Approved before" className="rounded-xl border border-zinc-200 bg-surface p-4">
          <Eyebrow>Approved before</Eyebrow>
          <ul className="list-disc pl-5 text-sm">{before.length ? before.map((l) => <li key={l}>{l}</li>) : <li>Not recorded on this computer</li>}</ul>
        </section>
        <section aria-label="New permissions" className="rounded-xl border border-teal-300 bg-surface p-4">
          <Eyebrow>New permissions</Eyebrow>
          <ul className="list-disc pl-5 text-sm">
            {after.map((l) => (
              <li key={l} className={before.includes(l) ? '' : 'font-semibold text-ink'}>
                {l}
                {before.length > 0 && !before.includes(l) ? ' (new)' : ''}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="mt-4 flex gap-3">
        <Btn className="px-4 py-2 text-sm" disabled={busy} onClick={() => void approve()}>
          Approve new permissions
        </Btn>
        <Btn variant="quiet" className="px-4 py-2 text-sm" onClick={() => go({ name: 'library' })}>
          Back to Your swarms
        </Btn>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
