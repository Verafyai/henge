import type { SwarmSummary } from '@swarm-explorer/api-client';
import { categoryLabel } from '@swarm-explorer/core';
import { Chip } from '@swarm-explorer/ui';
import { permissionLines, rewardLine, verificationLabel } from '@/lib/view';

export function SwarmCard({ s }: { s: SwarmSummary }) {
  const reward = rewardLine(s);
  return (
    <a href={`/swarms/${s.slug}`} className="group flex h-full flex-col rounded-card border border-zinc-200 bg-white p-5 shadow-sm hover:border-brand">
      <span className="flex flex-wrap gap-2">
        <Chip tone="info">{categoryLabel(s.category)}</Chip>
        <Chip tone={s.funding.mode === 'funded' ? 'approved' : 'neutral'}>{s.funding.mode === 'funded' ? 'Funded' : 'Volunteer'}</Chip>
      </span>
      <h3 className="mt-3 text-xl font-bold text-ink group-hover:text-brand">{s.name}</h3>
      <p className="mt-1 text-sm text-zinc-500">by {s.publisher.name}</p>
      <p className="mt-3 flex-1 text-zinc-700">{s.summary}</p>
      <dl className="mt-4 space-y-1.5 border-t border-zinc-100 pt-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">Reward</dt>
          <dd className="text-right font-semibold text-ink">{reward.text}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">Verified by</dt>
          <dd className="text-right font-semibold text-ink">{s.verification.map((v) => verificationLabel[v]).join(', ')}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">Permissions</dt>
          <dd className="text-right text-ink">{permissionLines(s.permissions)[0]}</dd>
        </div>
      </dl>
      {reward.note && <p className="mt-2 text-xs text-zinc-500">{reward.note}</p>}
    </a>
  );
}
