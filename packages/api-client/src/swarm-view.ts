/**
 * Swarm facts as people read them, shared by the website and Henge so both say the same thing.
 * The swarm page answers six questions in the source order of SPEC 4.2: purpose and publisher,
 * public outcomes, requirements, rewards and acceptance rate, verification, trust and reports.
 */
import { categoryLabel, formatCredits } from '@swarm-explorer/core';
import type { SwarmDetail, SwarmSummary } from './contracts';

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

export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function formatGb(gb: number): string {
  return gb >= 1 ? `${gb} GB` : `${Math.round(gb * 1000)} MB`;
}

/** Permission wording from SPEC 11.4. */
export function permissionLines(p: SwarmSummary['permissions']): string[] {
  const lines = [p.network.length ? `Can reach ${joinAnd(p.network)}` : 'No network access'];
  if (p.scratchDiskGb > 0) lines.push(`Up to ${formatGb(p.scratchDiskGb)} of working space`);
  if (p.gpuCompute) lines.push('GPU compute beyond model inference (needs your explicit approval)');
  if (p.apiSpendDailyUsd !== null) lines.push(`API spend up to $${p.apiSpendDailyUsd} a day, within your own caps`);
  return lines;
}

export function formatDuration(s: number): string {
  if (s % 86_400 === 0) return `${s / 86_400} ${s === 86_400 ? 'day' : 'days'}`;
  if (s % 3_600 === 0) return `${s / 3_600} ${s === 3_600 ? 'hour' : 'hours'}`;
  if (s % 60 === 0) return `${s / 60} minutes`;
  return `${s} seconds`;
}

/** Acceptance rate with its sample and time range, or the honest "not enough history" (SPEC 4.2). */
export function acceptanceText(a: SwarmDetail['acceptance']): string {
  if (a.status === 'not_enough_history') return 'Not enough history yet';
  const day = (iso: string) => iso.slice(0, 10);
  return `${(a.acceptedBp / 100).toFixed(1)}% of ${a.sample} results, ${day(a.from)} to ${day(a.to)}`;
}

export type SwarmFact = { label: string; value: string };
export type SwarmQuestion = {
  id: 'purpose' | 'outcomes' | 'requirements' | 'rewards' | 'verification' | 'trust';
  question: string;
  facts: SwarmFact[];
  /** Lines shown as a list, such as permissions or outcomes. */
  items: string[];
  note: string | null;
};

/** The six swarm-page questions, always in this order. */
export function swarmQuestions(s: SwarmDetail): SwarmQuestion[] {
  const reward = rewardLine(s);
  const v = s.verificationConfig;
  return [
    {
      id: 'purpose',
      question: 'What is it for, and who runs it?',
      facts: [
        { label: 'Purpose', value: s.summary },
        { label: 'Publisher', value: s.publisher.badge === 'verified' ? `${s.publisher.name} (verified)` : `${s.publisher.name} (verification pending)` },
        { label: 'Category', value: categoryLabel(s.category) },
      ],
      items: [],
      note: s.publisher.badge === 'verified' ? 'Verified means the publisher proved control of its domain or GitHub organization. It is not an endorsement.' : null,
    },
    {
      id: 'outcomes',
      question: 'What has it produced?',
      facts: [],
      items: s.outcomes.map((o) => o.title),
      note: s.outcomes.length ? null : 'No verified results yet. Results appear here with receipts once they pass verification.',
    },
    {
      id: 'requirements',
      question: 'What does it need from your computer?',
      facts: [
        { label: 'Models', value: s.models.classes.length ? `${policyLabel[s.models.policy]}: ${s.models.classes.join(', ')}` : policyLabel[s.models.policy] },
        { label: 'Harness', value: `${s.harness.name} ${s.harness.version}, runs in the sandbox` },
        { label: 'Qualification', value: `Match ${s.qualification.pass} of ${s.qualification.tasks} known answers` },
        { label: 'Time per task', value: `Up to ${formatDuration(s.task.timeoutS)}` },
      ],
      items: permissionLines(s.permissions),
      note: 'A new release that changes these permissions stops and asks you again.',
    },
    {
      id: 'rewards',
      question: 'What does it pay, and how often is work accepted?',
      facts: [
        { label: 'Reward', value: reward.text },
        { label: 'Acceptance rate', value: acceptanceText(s.acceptance) },
      ],
      items: [],
      note: reward.note,
    },
    {
      id: 'verification',
      question: 'How is work checked?',
      facts: [
        { label: 'Checked by', value: s.verification.map((m) => verificationLabel[m]).join(', ') },
        ...(v.juryPanelSize ? [{ label: 'Jury panel', value: `${v.juryPanelSize} independent models` }] : []),
        ...(v.redundancyCount ? [{ label: 'Redundancy', value: `${v.redundancyCount} nodes per task` }] : []),
        { label: 'Review window', value: formatDuration(v.pendingWindowS) },
      ],
      items: [],
      note: 'Unverified work earns nothing. No one grades their own work.',
    },
    {
      id: 'trust',
      question: 'Can you trust it?',
      facts: [
        { label: 'Release reviewed', value: s.trust.releaseReviewed ? 'Yes' : 'Not yet' },
        { label: 'Harness reviewed', value: s.trust.harnessReviewed ? 'Yes' : 'Not yet' },
        { label: 'Signed by', value: s.trust.signatureKeyId ?? 'Unsigned' },
        { label: 'Open reports', value: String(s.trust.openReports) },
        { label: 'Data', value: s.dataPolicy.sensitiveDataProhibited ? `${s.dataPolicy.publicInputs ? 'Public inputs' : 'Private inputs'}, no sensitive data` : 'See publisher policy' },
        { label: 'Retention', value: `${s.dataPolicy.retentionDays} days` },
      ],
      items: [],
      note: null,
    },
  ];
}
