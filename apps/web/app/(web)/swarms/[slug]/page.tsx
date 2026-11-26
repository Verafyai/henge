import { categoryLabel } from '@swarm-explorer/core';
import { getSwarm } from '@swarm-explorer/db';
import { Chip } from '@swarm-explorer/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { toSwarmDetail } from '@/lib/api';
import { swarmQuestions } from '@/lib/view';

export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const row = await getSwarm((await params).slug);
  return { title: row ? row.manifest.name : 'Swarm not found' };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-zinc-100 py-2 text-sm last:border-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}

/** Public swarm page (SPEC 4.1, 4.2): the six questions in source order. Browse-only: joining happens in Henge. */
export default async function SwarmPage({ params }: { params: Params }) {
  const row = await getSwarm((await params).slug);
  if (!row) notFound();
  const s = toSwarmDetail(row);
  const deepLink = `henge://swarm/${s.slug}`;

  return (
    <article className="mx-auto max-w-[1080px] px-4 py-12 sm:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="info">{categoryLabel(s.category)}</Chip>
        <Chip tone={s.funding.mode === 'funded' ? 'approved' : 'neutral'}>{s.funding.mode === 'funded' ? 'Funded' : 'Volunteer'}</Chip>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">Example data</span>
      </div>
      <h1 className="mt-4 text-4xl font-bold tracking-tight text-ink">{s.name}</h1>
      <p className="mt-1 text-zinc-500">
        by {s.publisher.name}
        {s.publisher.badge !== 'verified' && ' (publisher verification pending)'}
      </p>
      <p className="mt-4 max-w-3xl text-lg text-zinc-700">{s.summary}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <a href={deepLink} className="inline-flex min-h-12 items-center rounded-lg bg-brand px-6 font-semibold text-white hover:bg-brand-hover">
          Open in Henge
        </a>
        <a href="/download" className="inline-flex min-h-12 items-center rounded-lg border border-zinc-300 bg-white px-6 font-semibold text-ink hover:border-brand">
          Get the app
        </a>
      </div>
      <p className="mt-2 text-xs text-zinc-500">Opening the app shows this swarm. Nothing joins, installs or runs until you confirm there.</p>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {swarmQuestions(s).map((q) => (
          <section key={q.id} aria-labelledby={`q-${q.id}`} data-question={q.id} className="rounded-card border border-zinc-200 bg-white p-5">
            <h2 id={`q-${q.id}`} className="font-semibold text-ink">
              {q.question}
            </h2>
            {q.facts.length > 0 && (
              <dl className="mt-2">
                {q.facts.map((f) => (
                  <Fact key={f.label} label={f.label}>
                    {f.value}
                  </Fact>
                ))}
              </dl>
            )}
            {q.items.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
                {q.items.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
            {q.note && <p className="mt-2 text-xs text-zinc-500">{q.note}</p>}
          </section>
        ))}
      </div>
      <p className="mt-6 break-all font-mono text-[11px] text-zinc-500">Manifest {s.release.manifestHash}</p>
    </article>
  );
}
