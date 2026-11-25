import type { SwarmSummary } from '@swarm-explorer/api-client';
import { formatCredits } from '@swarm-explorer/core';

export function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export const verificationLabel: Record<SwarmSummary['verification'][number], string> = {
  'machine-check': 'Machine check',
  'known-answers': 'Known answers',
  redundancy: 'Redundancy',
  jury: 'Independent jury',
  'publisher-review': 'Publisher review',
};

/** What a node gets for accepted work. Never an income projection (SPEC 3.1, 9.7). */
export function rewardText(s: Pick<SwarmSummary, 'funding'>): string {
  return s.funding.mode === 'funded' ? `${formatCredits(s.funding.creditsPerAcceptedTask)} per accepted task` : 'Impact only';
}

/** Permission wording from SPEC 11.4. */
export function permissionLines(p: SwarmSummary['permissions']): string[] {
  const lines = [p.network.length ? `Can reach ${p.network.join(', ')}` : 'No network access'];
  if (p.scratchDiskGb > 0) lines.push(`Up to ${p.scratchDiskGb >= 1 ? `${p.scratchDiskGb} GB` : `${Math.round(p.scratchDiskGb * 1000)} MB`} of working space`);
  if (p.gpuCompute) lines.push('GPU compute beyond model inference');
  if (p.apiSpendDailyUsd !== null) lines.push(`API spend up to $${p.apiSpendDailyUsd} a day, within your caps`);
  return lines;
}
