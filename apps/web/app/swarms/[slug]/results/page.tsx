import { publicSwarmResults } from '@swarm-explorer/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const r = await publicSwarmResults((await params).slug, 1);
  return { title: r ? `${r.swarm.name} results` : 'Swarm not found' };
}

const METHOD: Record<string, string> = {
  'machine-check': 'Machine check',
  'known-answers': 'Known answers',
  redundancy: 'Redundancy',
  jury: 'Jury',
  'publisher-review': 'Publisher review',
};

const fmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

/**
 * Public results (M7): only work that reached Settled, with the hashes and pins that produced it and
 * the methods that accepted it, plus counts. No inputs, outputs, people or computers (SPEC 14).
 */
export default async function SwarmResultsPage({ params }: { params: Params }) {
  const r = await publicSwarmResults((await params).slug);
  if (!r) notFound();
  const c = r.counts;
  const counts: Array<[string, number, string]> = [
    ['Settled', c.settled, 'counts-settled'],
    ['Pending review', c.pending, 'counts-pending'],
    ['Being verified', c.inVerification, 'counts-verifying'],
    ['Not accepted', c.rejected, 'counts-rejected'],
    ['Impact settled', c.impactSettled, 'counts-impact'],
  ];
  return (
    <article className="mx-auto max-w-[1080px] px-4 py-12 sm:px-8">
      <a href={`/swarms/${r.swarm.slug}`} className="text-sm text-brand hover:underline">
        {r.swarm.name}
      </a>
      <h1 className="mt-2 text-4xl font-bold tracking-tight text-ink">Verified results</h1>
      <p className="mt-2 max-w-3xl text-zinc-700">
        Only results that passed verification and settled are listed. Each contributor gets a signed receipt for their own settled work, which anyone can check offline.
      </p>
      <dl aria-label="Counts" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {counts.map(([label, n, id]) => (
          <div key={id} className="rounded-card border border-zinc-200 bg-white p-4">
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-ink" data-testid={id}>
              {n}
            </dd>
          </div>
        ))}
      </dl>
      {r.items.length === 0 ? (
        <p className="mt-8 text-zinc-600">No settled results yet.</p>
      ) : (
        <ul aria-label="Settled results" className="mt-8 space-y-3">
          {r.items.map((i) => (
            <li key={i.resultId} data-testid="public-result" className="rounded-card border border-zinc-200 bg-white p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-ink">{`Settled ${fmt.format(new Date(i.settledAt))} UTC`}</span>
                <span className="text-zinc-600">{`${i.impactUnits} impact`}</span>
              </div>
              <p className="mt-1 text-zinc-600">{`Checked by ${i.verification.map((v) => METHOD[v.method] ?? v.method).join(', ') || 'no recorded method'}`}</p>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs text-zinc-500">
                <dt>Result</dt>
                <dd className="break-all font-mono">{i.resultId}</dd>
                <dt>Output hash</dt>
                <dd className="break-all font-mono">{i.outputSha256}</dd>
                <dt>Harness</dt>
                <dd className="break-all font-mono">{`${i.harness.name} ${i.harness.version} ${i.harness.hash}`}</dd>
                <dt>Model</dt>
                <dd className="break-all font-mono">{i.modelArtifactHash ?? 'not recorded'}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
