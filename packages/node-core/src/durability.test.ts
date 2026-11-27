import { describe, expect, it } from 'vitest';
import { addSpend, capDecision, DAILY_CAP_PAUSED, effectiveCap, localDay, parseUsd, spentToday } from './budget';
import { countSubmissions, IDEMPOTENCY_KEY_PATTERN, leaseRequestKey, planRecovery, resultSubmitKey, resumeDecision } from './recovery';

const lease = (id: string) => ({ id, status: 'running', deadlineAt: '2026-11-26T12:00:00.000Z', swarm: 's' });

describe('recovery after a kill (spin-out 9.3)', () => {
  it('keeps leases owned by a resumed workflow and abandons orphans', () => {
    const plan = planRecovery([lease('a'), lease('b')], [{ workflowId: 'w1', leaseId: 'a' }]);
    expect(plan).toEqual({ resume: ['w1'], abandon: ['b'], deferred: false });
  });

  it('abandons nothing while a lease step is in flight, since its retry may adopt the granted lease', () => {
    const plan = planRecovery([lease('a')], [{ workflowId: 'w1', leaseId: null }]);
    expect(plan).toEqual({ resume: ['w1'], abandon: [], deferred: true });
  });

  it('with no workflows every open lease is an orphan (the M5 behaviour)', () => {
    expect(planRecovery([lease('a')], []).abandon).toEqual(['a']);
    expect(planRecovery([], [])).toEqual({ resume: [], abandon: [], deferred: false });
  });

  it('derives idempotency keys from durable ids only', () => {
    expect(leaseRequestKey('swarm-task-1')).toBe(leaseRequestKey('swarm-task-1'));
    expect(resultSubmitKey('L1')).toBe('henge-result-L1');
    expect(resultSubmitKey('L1')).not.toBe(resultSubmitKey('L2'));
    expect(leaseRequestKey('swarm-task-1')).not.toBe(leaseRequestKey('swarm-task-2'));
    for (const k of [leaseRequestKey('x'.repeat(400)), resultSubmitKey('00000000-0000-7000-8000-000000000001')]) expect(k).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it('abandons a resumed lease past its deadline before running, renews near it, always submits a finished result', () => {
    const leasedAt = 0;
    const deadlineAt = 100_000;
    expect(resumeDecision({ step: 'run', leasedAt, deadlineAt, now: 10_000 })).toEqual({ action: 'continue' });
    expect(resumeDecision({ step: 'run', leasedAt, deadlineAt, now: 85_000 })).toEqual({ action: 'renew' });
    expect(resumeDecision({ step: 'run', leasedAt, deadlineAt, now: 100_000 })).toEqual({ action: 'abandon', reason: 'deadline_passed' });
    expect(resumeDecision({ step: 'submit', leasedAt, deadlineAt, now: 500_000 })).toEqual({ action: 'continue' });
  });

  it('counts a replayed or duplicate answer as no second result', () => {
    expect(countSubmissions([{ status: 201 }, { status: 200, replayed: true }, { status: 200, duplicate: true }, { status: 503 }])).toEqual({ results: 1, duplicates: 2 });
  });
});

describe('daily cap (spin-out 6.4, 9.6)', () => {
  const day1 = new Date(2026, 10, 26, 23, 59);
  const day2 = new Date(2026, 10, 27, 0, 1);

  it('allows calls only while spend is below the cap', () => {
    expect(capDecision(null, 10 ** 12)).toEqual({ ok: true, remainingUsdMicros: null });
    expect(capDecision(10_000, 0)).toEqual({ ok: true, remainingUsdMicros: 10_000 });
    expect(capDecision(10_000, 9_999)).toEqual({ ok: true, remainingUsdMicros: 1 });
    expect(capDecision(10_000, 10_000)).toEqual({ ok: false, code: 'daily_cap_reached', detail: DAILY_CAP_PAUSED });
    expect(DAILY_CAP_PAUSED).toBe('Paused: daily cap reached');
  });

  it('a $0.01 cap is reached by one call reporting one cent', () => {
    const cap = parseUsd('0.01');
    expect(cap).toBe(10_000);
    const s = addSpend(null, 10_000, day1);
    expect(capDecision(cap, spentToday(s, day1)).ok).toBe(false);
  });

  it('resets at the local day boundary', () => {
    const s = addSpend(addSpend(null, 4, day1), 5, day1);
    expect(s).toEqual({ day: localDay(day1), usdMicros: 9 });
    expect(spentToday(s, day2)).toBe(0);
    expect(addSpend(s, 1, day2)).toEqual({ day: localDay(day2), usdMicros: 1 });
  });

  it('refuses bad amounts instead of rounding them', () => {
    expect(() => addSpend(null, -1, day1)).toThrow();
    expect(() => addSpend(null, 0.5, day1)).toThrow();
    expect(() => parseUsd('1.1234567')).toThrow();
    expect(() => parseUsd('-1')).toThrow();
    expect(parseUsd('')).toBeNull();
    expect(parseUsd('12.5')).toBe(12_500_000);
  });

  it('the tightest cap wins', () => {
    expect(effectiveCap(null, undefined)).toBeNull();
    expect(effectiveCap(50, null, 20)).toBe(20);
  });
});
