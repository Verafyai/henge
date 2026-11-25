import type { SwarmSummary } from '@swarm-explorer/api-client';
import { categories, categoryLabel } from '@swarm-explorer/core';
import { Chip } from '@swarm-explorer/ui';
import { useNode, useRecent, useSwarms } from '../api';
import { useNav } from '../router';
import { Btn, Empty, Eyebrow } from '../ui/bits';
import { permissionLines, rewardText, verificationLabel } from '../view';

function SwarmTile({ s }: { s: SwarmSummary }) {
  const { go } = useNav();
  return (
    <li>
      <button
        type="button"
        aria-label={`Open ${s.name}`}
        onClick={() => go({ name: 'swarm', slug: s.slug })}
        className="flex h-full w-full flex-col rounded-xl border border-zinc-200 bg-white p-4 text-left hover:border-brand"
      >
        <span className="flex flex-wrap gap-1.5">
          <Chip tone="info">{categoryLabel(s.category)}</Chip>
          <Chip tone={s.funding.mode === 'funded' ? 'approved' : 'neutral'}>{s.funding.mode === 'funded' ? 'Funded' : 'Volunteer'}</Chip>
        </span>
        <span className="mt-2 text-lg font-bold text-ink">{s.name}</span>
        <span className="text-xs text-zinc-500">by {s.publisher.name}</span>
        <span className="mt-2 flex-1 text-sm text-zinc-700">{s.summary}</span>
        <span className="mt-3 block border-t border-zinc-100 pt-2 text-xs text-zinc-600">
          <b className="text-ink">{rewardText(s)}</b> · {s.verification.map((v) => verificationLabel[v]).join(', ')} · {permissionLines(s.permissions)[0]}
        </span>
      </button>
    </li>
  );
}

/** Store home (SPEC 4.2): featured swarms, category tiles, Your node panel. No store-sale UI. */
export function StorePage({ category }: { category?: string }) {
  const swarms = useSwarms();
  const recent = useRecent();
  const node = useNode();
  const { go } = useNav();
  const setup = node.data?.setup ?? null;
  const all = swarms.data ?? [];
  const shown = category ? all.filter((s) => s.category === category) : all;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{category ? categoryLabel(category) : 'Pick a cause'}</h1>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">Example data</span>
      </div>

      <section aria-label="Categories" className="mt-4">
        <ul className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {categories.map((c) => {
            const n = all.filter((s) => s.category === c.key).length;
            return (
              <li key={c.key}>
                <button
                  type="button"
                  aria-pressed={category === c.key}
                  onClick={() => go(category === c.key ? { name: 'store' } : { name: 'store', category: c.key })}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${category === c.key ? 'border-brand bg-teal-50' : 'border-zinc-200 bg-white hover:border-brand'}`}
                >
                  <span className="block font-semibold text-ink">{c.label}</span>
                  <span className="text-xs text-zinc-500">{n ? `${n} listed` : 'Coming soon'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_280px]">
        <section aria-label="Featured swarms">
          <Eyebrow>{category ? 'Swarms in this category' : 'Featured swarms'}</Eyebrow>
          {swarms.isPending ? (
            <p className="text-sm text-zinc-500">Loading swarms</p>
          ) : swarms.isError ? (
            <Empty title="The catalog could not be reached.">Check your connection. Swarms you have viewed stay listed under Recently viewed.</Empty>
          ) : shown.length === 0 ? (
            <Empty title="No listed swarm in this category yet." />
          ) : (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((s) => (
                <SwarmTile key={s.slug} s={s} />
              ))}
            </ul>
          )}
        </section>

        <aside aria-label="Your node" className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <Eyebrow>Your node</Eyebrow>
            {setup ? (
              <>
                <p className="text-sm font-semibold text-ink">{node.data?.paused ? 'Paused' : `${{ local: 'Local', api: 'API key', hybrid: 'Hybrid' }[setup.mode]} mode`}</p>
                <p className="mt-1 text-xs text-zinc-600">{`Cause: ${all.find((s) => s.slug === setup.swarm)?.name ?? setup.swarm}. ${node.data?.models.installed.length ? `${node.data.models.installed.length} model ready.` : 'No model downloaded yet.'} Joining arrives in M4, so nothing runs yet.`}</p>
                <Btn variant="quiet" className="mt-2 px-2 py-1 text-xs" onClick={() => go({ name: 'models' })}>
                  Models and storage
                </Btn>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink">Not set up yet</p>
                <Btn variant="quiet" className="mt-2 px-2 py-1 text-xs" onClick={() => go({ name: 'setup' })}>
                  Pick a cause
                </Btn>
              </>
            )}
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <Eyebrow>Recently viewed</Eyebrow>
            {(recent.data ?? []).length === 0 ? (
              <p className="text-xs text-zinc-500">Swarms you open appear here, even offline.</p>
            ) : (
              <ul className="space-y-1">
                {recent.data!.map((slug) => (
                  <li key={slug}>
                    <Btn variant="quiet" className="w-full justify-start px-2 py-1 text-xs" onClick={() => go({ name: 'swarm', slug })}>
                      {slug}
                    </Btn>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
