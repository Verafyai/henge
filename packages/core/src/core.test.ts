import { describe, expect, it } from 'vitest';
import {
  availabilityStates,
  canTransitionLease,
  categories,
  formatCredits,
  formatDeadline,
  formatImpact,
  formatUsdMicros,
  hasForbiddenDash,
  incomeClaim,
  leaseStates,
  primaryAvailability,
  terminalLeaseStates,
  timeLeft,
  usdToMicros,
} from './index';

describe('credits and money', () => {
  it('formats integer credits and impact separately', () => {
    expect(formatCredits(1)).toBe('1 credit');
    expect(formatCredits(2450)).toBe('2,450 credits');
    expect(formatImpact(30)).toBe('30 impact');
    expect(() => formatCredits(1.5)).toThrow();
  });
  it('formats USD micros for small API costs and caps', () => {
    expect(formatUsdMicros(4_000)).toBe('$0.004');
    expect(formatUsdMicros(12_500_000)).toBe('$12.50');
    expect(formatUsdMicros(0)).toBe('$0.00');
    expect(usdToMicros(1.25)).toBe(1_250_000);
    expect(() => formatUsdMicros(0.5)).toThrow();
  });
});

describe('time', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  it('counts down', () => {
    expect(timeLeft(new Date('2026-12-06T12:00:00Z'), now).label).toBe('12 days');
    expect(timeLeft(new Date('2026-11-24T13:30:00Z'), now).label).toBe('1 hour');
    expect(timeLeft(new Date('2026-11-24T11:00:00Z'), now).label).toBe('Ended');
  });
  it('labels the zone', () => {
    expect(formatDeadline(new Date('2026-12-07T00:12:00Z'), 'America/Los_Angeles')).toBe('Dec 6, 2026, 4:12 PM PST');
  });
});

describe('categories', () => {
  it('are the seven SPEC 3.1 causes in order', () => {
    expect(categories.map((c) => c.label)).toEqual(['Governance', 'Mathematics', 'Security', 'Science', 'Healthcare', 'Public goods', 'Gaming']);
  });
});

describe('availability states (SPEC 4.2)', () => {
  it('covers every distinct state the spec names', () => {
    const keys = availabilityStates.map((s) => s.key);
    for (const k of ['no_tasks', 'not_qualified', 'policy_mismatch', 'pool_empty', 'budget_capped', 'run_rules_paused', 'publisher_paused', 'platform_halted', 'verification_pending'])
      expect(keys).toContain(k);
    expect(new Set(availabilityStates.map((s) => s.label)).size).toBe(availabilityStates.length);
  });
  it('never calls a waiting node "working" or "idle"', () => {
    for (const s of availabilityStates) {
      expect(s.label).not.toMatch(/\b(working|idle)\b/i);
      expect(s.detail).not.toMatch(/\bworking\b/i);
    }
    expect(availabilityStates.find((s) => s.key === 'run_rules_paused')!.detail).toMatch(/^Ready, waiting for/);
  });
  it('shows the most important applying state', () => {
    expect(primaryAvailability(['no_tasks', 'platform_halted'])).toBe('platform_halted');
    expect(primaryAvailability([])).toBeNull();
  });
});

describe('lease state machine (SPEC 7.3)', () => {
  it('matches the diagram', () => {
    expect(canTransitionLease('queued', 'leased')).toBe(true);
    expect(canTransitionLease('running', 'abandoned')).toBe(true);
    expect(canTransitionLease('pending', 'clawed_back')).toBe(true);
    expect(canTransitionLease('abandoned', 'pending')).toBe(false);
    expect(canTransitionLease('expired', 'submitted')).toBe(false);
    expect(canTransitionLease('settled', 'clawed_back')).toBe(false);
    expect(terminalLeaseStates.sort()).toEqual(['clawed_back', 'rejected', 'settled']);
  });
  it('every non-terminal state can reach a terminal state', () => {
    const reach = (s: string, seen = new Set<string>()): boolean => {
      if (terminalLeaseStates.includes(s as never)) return true;
      if (seen.has(s)) return false;
      seen.add(s);
      return leaseStates.filter((t) => canTransitionLease(s as never, t)).some((t) => reach(t, seen));
    };
    for (const s of leaseStates) expect(reach(s), s).toBe(true);
  });
});

describe('copy rules', () => {
  it('flags dashes', () => {
    expect(hasForbiddenDash('Stage funds — held')).toBe(true);
    expect(hasForbiddenDash('Up to 2 GB of working space')).toBe(false);
  });
  it('flags income and token phrasing', () => {
    expect(incomeClaim('Turn your GPU into side income')).toBe('side income');
    expect(incomeClaim('Cash out anytime')).toBe('Cash out');
    expect(incomeClaim('Earn credits for verified work, usable inside the network')).toBeNull();
  });
});
