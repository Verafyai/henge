/**
 * Why a joined swarm is not doing work right now. SPEC 4.2 requires these to stay
 * distinct; the UI never collapses them into "idle". Order is display priority:
 * the first that applies is the one shown.
 */
export const availabilityStates = [
  { key: 'platform_halted', label: 'Halted by Verafy', detail: 'This swarm was stopped network-wide pending review.' },
  { key: 'publisher_paused', label: 'Paused by publisher', detail: 'The publisher paused new tasks.' },
  { key: 'reconsent_required', label: 'Needs your approval', detail: 'A new release changed what this swarm can do. Review it to continue.' },
  { key: 'not_qualified', label: 'Not qualified', detail: 'Pass the qualification tasks to receive work.' },
  { key: 'policy_mismatch', label: 'Model does not fit', detail: "None of your models matches this swarm's model policy." },
  { key: 'budget_capped', label: 'Spend cap reached', detail: 'An API spend cap stopped work until it resets or you raise it.' },
  { key: 'run_rules_paused', label: 'Waiting for your run rules', detail: 'Ready, waiting for idle, power, network or temperature rules to allow work.' },
  { key: 'pool_empty', label: 'Pool empty', detail: "The publisher's prepaid pool has no credits available for new paid tasks." },
  { key: 'no_tasks', label: 'No tasks', detail: 'The swarm has no tasks waiting. Your share is lent to other swarms meanwhile.' },
  { key: 'verification_pending', label: 'Verification pending', detail: 'Your submitted work is waiting for verification.' },
] as const;

export type AvailabilityState = (typeof availabilityStates)[number]['key'];

export function availabilityLabel(key: AvailabilityState): string {
  return availabilityStates.find((s) => s.key === key)!.label;
}

/** Pick the state to display from every state that currently applies. */
export function primaryAvailability(applying: readonly AvailabilityState[]): AvailabilityState | null {
  return availabilityStates.find((s) => applying.includes(s.key))?.key ?? null;
}

/** Lease states and allowed transitions, exactly the SPEC 7.3 diagram. */
export const leaseTransitions = {
  queued: ['leased'],
  leased: ['running', 'expired'],
  running: ['submitted', 'abandoned', 'expired'],
  submitted: ['verifying', 'rejected'],
  verifying: ['pending', 'rejected'],
  pending: ['settled', 'clawed_back'],
  abandoned: ['requeued'],
  expired: ['requeued'],
  requeued: ['queued'],
  rejected: [],
  settled: [],
  clawed_back: [],
} as const satisfies Record<string, readonly string[]>;

export type LeaseState = keyof typeof leaseTransitions;
export const leaseStates = Object.keys(leaseTransitions) as LeaseState[];
export const terminalLeaseStates: LeaseState[] = leaseStates.filter((s) => leaseTransitions[s].length === 0);

export function canTransitionLease(from: LeaseState, to: LeaseState): boolean {
  return (leaseTransitions[from] as readonly string[]).includes(to);
}

/** Only these lease outcomes can ever carry a reward; abandoned and expired work is never paid (SPEC 1.3, 7.3). */
export const rewardableLeaseStates: LeaseState[] = ['pending', 'settled'];
