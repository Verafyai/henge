import { categoryLabel } from '@swarm-explorer/core';
import { getSwarm } from '@swarm-explorer/db';
import { Chip } from '@swarm-explorer/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { toSwarmDetail } from '@/lib/api';
import { formatDuration, permissionLines, policyLabel, rewardLine, verificationLabel } from '@/lib/view';

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

/** Public swarm page (SPEC 4.1). Browse-only: joining happens in the desktop client. */
export default async function SwarmPage({ params }: { params: Params }) {
  const row = await getSwarm((await params).slug);
  if (!row) notFound();
  const s = toSwarmDetail(row);
  const reward = rewardLine(s);
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

      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <section aria-labelledby="reward" className="rounded-card border border-zinc-200 bg-white p-5">
          <h2 id="reward" className="font-semibold text-ink">Reward and verification</h2>
          <dl className="mt-2">
            <Fact label="Reward">{reward.text}</Fact>
            <Fact label="Verified by">{s.verification.map((v) => verificationLabel[v]).join(', ')}</Fact>
            <Fact label="Pending window">{formatDuration(s.verificationConfig.pendingWindowS)}</Fact>
            <Fact label="Acceptance rate">{s.acceptance.status === 'measured' ? `${(s.acceptance.acceptedBp / 100).toFixed(1)}%` : 'Not enough history yet'}</Fact>
          </dl>
          {reward.note && <p className="mt-2 text-xs text-zinc-500">{reward.note}</p>}
        </section>

        <section aria-labelledby="perms" className="rounded-card border border-zinc-200 bg-white p-5">
          <h2 id="perms" className="font-semibold text-ink">What it can do on your node</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
            {permissionLines(s.permissions).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-zinc-500">Runs only inside the sandbox. A new release that changes these permissions asks you again.</p>
        </section>

        <section aria-labelledby="models" className="rounded-card border border-zinc-200 bg-white p-5">
          <h2 id="models" className="font-semibold text-ink">Models</h2>
          <dl className="mt-2">
            <Fact label="Policy">{policyLabel[s.models.policy]}</Fact>
            {s.models.classes.length > 0 && <Fact label="Classes">{s.models.classes.join(', ')}</Fact>}
            <Fact label="API models">{s.models.apiAllowed ? 'Allowed, with your keys and caps' : 'Not allowed'}</Fact>
            <Fact label="Qualification">{`Pass ${s.qualification.pass} of ${s.qualification.tasks} tasks`}</Fact>
          </dl>
        </section>

        <section aria-labelledby="trust" className="rounded-card border border-zinc-200 bg-white p-5">
          <h2 id="trust" className="font-semibold text-ink">Trust</h2>
          <dl className="mt-2">
            <Fact label="Harness">{`${s.harness.name} ${s.harness.version} (${s.harness.runtime})`}</Fact>
            <Fact label="Release reviewed">{s.trust.releaseReviewed ? 'Yes' : 'Not yet'}</Fact>
            <Fact label="Data">{s.dataPolicy.sensitiveDataProhibited ? 'Public inputs, no sensitive data' : 'See publisher policy'}</Fact>
            <Fact label="Retention">{`${s.dataPolicy.retentionDays} days`}</Fact>
          </dl>
          <p className="mt-2 break-all font-mono text-[11px] text-zinc-500">{s.release.manifestHash}</p>
        </section>
      </div>

      <section aria-labelledby="outcomes" className="mt-10">
        <h2 id="outcomes" className="text-xl font-bold text-ink">Verified outcomes</h2>
        {s.outcomes.length === 0 ? (
          <p className="mt-2 rounded-card border border-dashed border-zinc-300 p-5 text-zinc-600">No verified results yet. Results appear here with receipts once they pass verification.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {s.outcomes.map((o) => (
              <li key={o.id}>
                <a href={o.receiptUrl} className="text-brand">{o.title}</a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
