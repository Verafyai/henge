import type { MembershipStatus, SwarmSummary } from '@swarm-explorer/api-client';
import { rewardLine } from '@swarm-explorer/api-client/swarm-view';

/** Swarm wording is shared with the website so both say the same thing. */
export { permissionLines, swarmQuestions, verificationLabel } from '@swarm-explorer/api-client/swarm-view';

export function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/** What a node gets for accepted work. Never an income projection (SPEC 3.1, 9.7). */
export function rewardText(s: Pick<SwarmSummary, 'funding'>): string {
  return rewardLine(s).text;
}

/**
 * Membership states in words (SPEC 4.2): never reduced to "idle". An active swarm says whether
 * tasks are waiting or running (see activeLabel) rather than a generic "working".
 */
export const membershipLabel: Record<MembershipStatus, { text: string; tone: 'approved' | 'pending' | 'rejected' | 'info' | 'neutral' }> = {
  joining: { text: 'Waiting for your approval', tone: 'pending' },
  qualifying: { text: 'Qualifying', tone: 'info' },
  active: { text: 'Joined, no tasks yet', tone: 'approved' },
  paused: { text: 'Paused', tone: 'neutral' },
  reconsent_required: { text: 'Stopped: new permissions to review', tone: 'rejected' },
  left: { text: 'Left', tone: 'neutral' },
};

/** The label for a joined swarm, with its queue and whether this node is running one of its tasks. */
export function swarmLabel(m: { status: MembershipStatus; swarm: string; queue: { queued: number } | null }, runningSwarm: string | null) {
  if (m.status === 'active' && runningSwarm === m.swarm) return { text: 'Running a task', tone: 'info' as const };
  if (m.status === 'active' && m.queue && m.queue.queued > 0) return { text: `Joined, ${m.queue.queued} ${m.queue.queued === 1 ? 'task' : 'tasks'} waiting`, tone: 'approved' as const };
  return membershipLabel[m.status];
}
