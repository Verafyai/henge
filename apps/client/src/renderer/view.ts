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
 * Membership states in words (SPEC 4.2): never reduced to "idle". Tasks arrive with the
 * coordinator in M5, so an active swarm says there are no tasks yet rather than "working".
 */
export const membershipLabel: Record<MembershipStatus, { text: string; tone: 'approved' | 'pending' | 'rejected' | 'info' | 'neutral' }> = {
  joining: { text: 'Waiting for your approval', tone: 'pending' },
  qualifying: { text: 'Qualifying', tone: 'info' },
  active: { text: 'Joined, no tasks yet', tone: 'approved' },
  paused: { text: 'Paused', tone: 'neutral' },
  reconsent_required: { text: 'Stopped: new permissions to review', tone: 'rejected' },
  left: { text: 'Left', tone: 'neutral' },
};
