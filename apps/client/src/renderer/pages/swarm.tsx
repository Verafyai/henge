import { categoryLabel } from '@swarm-explorer/core';
import { Chip } from '@swarm-explorer/ui';
import { useEffect, type ReactNode } from 'react';
import { useRecordView, useSwarm } from '../api';
import { useNav } from '../router';
import { Btn, Empty, Eyebrow } from '../ui/bits';
import { permissionLines, rewardText, verificationLabel } from '../view';

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-zinc-200 bg-white p-4">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  );
}

/**
 * Swarm page. M4 builds the full SPEC 4.2 page with the six questions in order; this M0 view
 * shows the catalog facts and has no join action.
 */
export function SwarmPage({ slug }: { slug: string }) {
  const q = useSwarm(slug);
  const record = useRecordView();
  const { go } = useNav();
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
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="info">{categoryLabel(s.category)}</Chip>
        <Chip tone={s.funding.mode === 'funded' ? 'approved' : 'neutral'}>{s.funding.mode === 'funded' ? 'Funded' : 'Volunteer'}</Chip>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">Example data</span>
      </div>
      <h1 className="mt-3 text-3xl font-bold">{s.name}</h1>
      <p className="text-sm text-zinc-500">by {s.publisher.name}</p>
      <p className="mt-3 text-zinc-700">{s.summary}</p>
      <div className="mt-4 flex gap-3">
        <Btn className="px-4 py-2 text-sm" disabled title="Joining arrives in milestone M4">
          Join (arrives in M4)
        </Btn>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Box title="Reward">
          <p className="text-sm font-semibold text-ink">{rewardText(s)}</p>
          {s.funding.mode === 'funded' && s.funding.poolStatus === 'empty' && <p className="mt-1 text-xs text-zinc-600">Pool empty: no paid tasks until the publisher funds it.</p>}
          {s.funding.mode === 'volunteer' && <p className="mt-1 text-xs text-zinc-600">Volunteer swarm: accepted work earns impact, not credits.</p>}
        </Box>
        <Box title="Verification">
          <p className="text-sm text-ink">{s.verification.map((v) => verificationLabel[v]).join(', ')}</p>
          <p className="mt-1 text-xs text-zinc-600">{s.acceptance.status === 'measured' ? `${(s.acceptance.acceptedBp / 100).toFixed(1)}% accepted` : 'Acceptance rate: not enough history yet'}</p>
        </Box>
        <Box title="Permissions">
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink">
            {permissionLines(s.permissions).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Box>
        <Box title="Harness and models">
          <p className="text-sm text-ink">{`${s.harness.name} ${s.harness.version} (${s.harness.runtime})`}</p>
          <p className="mt-1 text-xs text-zinc-600">
            {s.models.classes.length ? `Classes: ${s.models.classes.join(', ')}` : 'Any qualifying model'}
            {s.models.apiAllowed ? ' · API models allowed with your caps' : ' · Local models only'}
          </p>
          <Btn variant="quiet" className="mt-2 px-2 py-1 text-xs" onClick={() => go({ name: 'model', slug: s.models.classes[0] ?? '' })}>
            See models
          </Btn>
        </Box>
      </div>
      <p className="mt-4 break-all font-mono text-[11px] text-zinc-500">Manifest {s.release.manifestHash}</p>
    </div>
  );
}

/** Target of swarmexplorer://join/{swarm}. A link can only open this review, never join (SPEC 4.4). */
export function JoinReview({ slug }: { slug: string }) {
  const q = useSwarm(slug);
  const { go } = useNav();
  return (
    <div className="mx-auto max-w-[720px] px-6 py-8">
      <h1 className="text-2xl font-bold">Review before joining</h1>
      <p className="mt-2 text-zinc-600">
        {q.data ? `A link asked to open ${q.data.name}.` : 'A link asked to open a swarm.'} Nothing has been joined, downloaded or run. Joining, with its
        permission review and qualification, arrives in milestone M4.
      </p>
      <Btn variant="quiet" className="mt-4 px-4 py-2 text-sm" onClick={() => go({ name: 'swarm', slug })}>
        View the swarm
      </Btn>
    </div>
  );
}
