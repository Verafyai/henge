import type { SwarmSummary } from '@swarm-explorer/api-client';
import { formatCredits } from '@swarm-explorer/core';

export const verificationLabel: Record<SwarmSummary['verification'][number], string> = {
  'machine-check': 'Machine check',
  'known-answers': 'Known answers',
  redundancy: 'Redundancy',
  jury: 'Independent jury',
  'publisher-review': 'Publisher review',
};

export const policyLabel: Record<SwarmSummary['models']['policy'], string> = {
  any: 'Any qualifying model',
  class: 'Models in a named class',
  diverse: 'Diverse panel across model families',
};

/** What a node gets for accepted work. Never an income projection (SPEC 3.1, 9.7). */
export function rewardLine(s: Pick<SwarmSummary, 'funding'>): { text: string; note: string | null } {
  if (s.funding.mode === 'volunteer') return { text: 'Impact only', note: 'Volunteer swarm: accepted work earns impact, not credits.' };
  return {
    text: `${formatCredits(s.funding.creditsPerAcceptedTask)} per accepted task`,
    note: s.funding.poolStatus === 'empty' ? 'Pool empty: no paid tasks until the publisher funds it.' : null,
  };
}

/** Permission wording from SPEC 11.4. */
export function permissionLines(p: SwarmSummary['permissions']): string[] {
  const lines = [p.network.length ? `Can reach ${joinAnd(p.network)}` : 'No network access'];
  if (p.scratchDiskGb > 0) lines.push(`Up to ${formatGb(p.scratchDiskGb)} of working space`);
  if (p.gpuCompute) lines.push('GPU compute beyond model inference (needs your explicit approval)');
  if (p.apiSpendDailyUsd !== null) lines.push(`API spend up to $${p.apiSpendDailyUsd} a day, within your own caps`);
  return lines;
}

function formatGb(gb: number): string {
  return gb >= 1 ? `${gb} GB` : `${Math.round(gb * 1000)} MB`;
}

export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

export function formatDuration(s: number): string {
  if (s % 86_400 === 0) return `${s / 86_400} ${s === 86_400 ? 'day' : 'days'}`;
  if (s % 3_600 === 0) return `${s / 3_600} ${s === 3_600 ? 'hour' : 'hours'}`;
  if (s % 60 === 0) return `${s / 60} minutes`;
  return `${s} seconds`;
}
