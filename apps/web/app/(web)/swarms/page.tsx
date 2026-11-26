import { categories } from '@swarm-explorer/core';
import { listSwarms } from '@swarm-explorer/db';
import { Eyebrow, HeroBackdrop } from '@swarm-explorer/ui';
import { toSwarmSummary } from '@/lib/api';
import { SwarmCard } from '../swarm-card';

export const dynamic = 'force-dynamic';

type SP = Promise<Record<string, string | string[] | undefined>>;

const creditSteps = [
  ['Verified output only', 'Credits reward results that pass verification, not compute time. Rejected or abandoned work earns nothing.'],
  ['Funded or volunteer', 'Funded swarms pay credits from a pool the publisher prepaid. Volunteer swarms award impact, which is not spendable.'],
  ['Spend inside the network', 'Credits run your own jobs and swarms. They are not a token and cannot be cashed out or transferred.'],
] as const;

export default async function Home({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim().toLowerCase() ?? '';
  const all = (await listSwarms()).map(toSwarmSummary);
  const shown = q ? all.filter((s) => `${s.name} ${s.summary} ${s.category}`.toLowerCase().includes(q)) : all;
  const ordered = [...shown.filter((s) => s.featured), ...shown.filter((s) => !s.featured)];

  return (
    <>
      <HeroBackdrop>
        <div className="mx-auto max-w-[1280px] px-4 pb-12 pt-16 text-center sm:px-8">
          <Eyebrow className="mb-6">Henge web by Verafy</Eyebrow>
          <h1 className="text-5xl font-bold leading-[1.05] tracking-tight text-ink sm:text-[64px]">An app store for swarms.</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-700">
            Install one node, connect a local model, and give its time to the causes you choose: juries, proofs, security research and more. Every
            result is verified before it counts.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <a href="/download" className="inline-flex min-h-12 items-center rounded-lg bg-brand px-6 font-semibold text-white shadow-sm hover:bg-brand-hover">
              Get Henge
            </a>
            <a href="#swarms" className="inline-flex min-h-12 items-center rounded-lg border border-zinc-300 bg-white/80 px-6 font-semibold text-ink hover:border-brand">
              Browse swarms
            </a>
          </div>
        </div>
      </HeroBackdrop>

      <section id="swarms" aria-labelledby="featured" className="mx-auto mt-4 max-w-[1280px] scroll-mt-24 px-4 sm:px-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 id="featured" className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            {q ? `Swarms matching "${q}"` : 'Featured swarms'}
          </h2>
          <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">Example data</span>
        </div>
        {ordered.length === 0 ? (
          <p className="rounded-card border border-dashed border-zinc-300 p-6 text-zinc-600">No listed swarm matches that search.</p>
        ) : (
          <ul className="grid gap-6 md:grid-cols-3">
            {ordered.map((s) => (
              <li key={s.slug}>
                <SwarmCard s={s} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="categories" aria-labelledby="cats" className="mx-auto mt-16 max-w-[1280px] scroll-mt-24 px-4 sm:px-8">
        <h2 id="cats" className="mb-4 text-xl font-bold text-ink">
          Pick a cause
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {categories.map((c) => {
            const n = all.filter((s) => s.category === c.key).length;
            return (
              <li key={c.key} className="rounded-card border border-zinc-200 bg-white p-4">
                <p className="font-semibold text-ink">{c.label}</p>
                <p className="mt-1 text-sm text-zinc-500">{n ? `${n} listed ${n === 1 ? 'swarm' : 'swarms'}` : 'Coming soon'}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="credits" className="mx-auto mt-16 max-w-[1280px] px-4 sm:px-8">
        <h2 id="credits" className="mb-4 text-xl font-bold text-ink">
          How credits and impact work
        </h2>
        <ol className="grid gap-6 sm:grid-cols-3">
          {creditSteps.map(([t, d], i) => (
            <li key={t} className="rounded-card border-2 border-brand bg-zinc-100 p-5">
              <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-brand text-sm font-bold text-white">
                {i + 1}
              </span>
              <h3 className="mt-3 font-semibold text-ink">{t}</h3>
              <p className="mt-1 text-sm text-zinc-600">{d}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
