import { describe, expect, it } from 'vitest';
import { evaluateRunRules, inSchedule, type Sensors } from './run-gate';
import { DEFAULT_RUN_RULES, describeRunRules, enforcementSupport, type RunRules } from './run-rules';
import { FairShareScheduler, type SwarmSlot } from './scheduler';

const slot = (id: string, shareBp: number, o: Partial<SwarmSlot> = {}): SwarmSlot => ({ id, shareBp, eligible: true, queued: 5, urgent: 0, ...o });

/** Runs `n` picks of equal length and counts who got each one. */
function simulate(s: FairShareScheduler, slots: () => SwarmSlot[], n: number, ms = 1000) {
  const got: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const next = s.order(slots())[0];
    if (!next) break;
    got[next] = (got[next] ?? 0) + 1;
    s.charge(next, ms, (slots().find((x) => x.id === next)?.urgent ?? 0) > 0);
  }
  return got;
}

describe('weighted fair queueing (SPEC 7.1)', () => {
  it('gives each swarm its share of time when all have work', () => {
    const s = new FairShareScheduler();
    const got = simulate(s, () => [slot('a', 7500), slot('b', 2500)], 400);
    expect(got).toEqual({ a: 300, b: 100 });
    const thirds = simulate(new FairShareScheduler(), () => [slot('a', 3334), slot('b', 3333), slot('c', 3333)], 300);
    expect(Math.max(...Object.values(thirds)) - Math.min(...Object.values(thirds))).toBeLessThanOrEqual(1);
  });

  it('picks the eligible swarm furthest below its share and skips ineligible ones', () => {
    const s = new FairShareScheduler();
    s.order([slot('a', 5000), slot('b', 5000)]);
    s.charge('a', 3000);
    expect(s.order([slot('a', 5000), slot('b', 5000)])[0]).toBe('b');
    expect(s.order([slot('a', 5000), slot('b', 5000, { eligible: false })])).toEqual(['a']);
  });

  it('a swarm with no tasks lends its time, keeps its share, and does not burst when it returns', () => {
    const s = new FairShareScheduler();
    let bHasWork = false;
    const slots = () => [slot('a', 5000), slot('b', 5000, { queued: bHasWork ? 5 : 0 })];
    expect(simulate(s, slots, 20)).toEqual({ a: 20 });
    bHasWork = true;
    // From here on they share 50/50; b does not take 20 runs in a row to "repay" what it lent.
    const after = simulate(s, slots, 20);
    expect(after.a).toBeGreaterThanOrEqual(9);
    expect(after.b).toBeGreaterThanOrEqual(9);
    expect(s.report().find((r) => r.id === 'b')!.shareBp).toBe(5000);
  });

  it('a 0 share swarm only borrows time nobody else needs', () => {
    const s = new FairShareScheduler();
    expect(s.order([slot('new', 0), slot('a', 10_000)])).toEqual(['a', 'new']);
    expect(s.order([slot('new', 0), slot('a', 10_000, { queued: 0 })])).toEqual(['new']);
  });

  it('urgent work jumps the queue but is charged to its swarm, showing a deficit others win back', () => {
    const s = new FairShareScheduler();
    let urgent = 3;
    const slots = () => [slot('a', 5000), slot('b', 5000, { urgent: urgent > 0 ? 1 : 0 })];
    for (let i = 0; i < 3; i++) {
      expect(s.order(slots())[0]).toBe('b');
      s.charge('b', 1000, true);
      urgent--;
    }
    const b = s.report().find((r) => r.id === 'b')!;
    expect(b).toMatchObject({ urgentMs: 3000, servedMs: 3000, deficitMs: 3000 });
    // a now runs until the time b took ahead of its share is won back.
    expect(simulate(s, slots, 3)).toEqual({ a: 3 });
    expect(s.report().find((r) => r.id === 'b')!.deficitMs).toBe(0);
  });
});

const quiet: Sensors = { idleSeconds: 600, onBattery: false, thermal: 'nominal', cpuLoadPct: 10, metered: null };
const mac = enforcementSupport('darwin');

describe('run rules are enforced (SPEC 7.2)', () => {
  it('only when idle: waits until 5 minutes without input, and stops when the user is back', () => {
    const now = new Date('2026-11-25T12:00:00');
    expect(evaluateRunRules(DEFAULT_RUN_RULES, quiet, mac, now)).toEqual({ canStart: true, mustStop: false, blocks: [] });
    const busy = evaluateRunRules(DEFAULT_RUN_RULES, { ...quiet, idleSeconds: 299 }, mac, now);
    expect(busy).toMatchObject({ canStart: false, mustStop: true, blocks: [{ rule: 'when' }] });
    expect(evaluateRunRules(DEFAULT_RUN_RULES, { ...quiet, idleSeconds: null }, mac, now).mustStop).toBe(true);
    expect(evaluateRunRules({ ...DEFAULT_RUN_RULES, when: { kind: 'always' } }, { ...quiet, idleSeconds: 0 }, mac, now).canStart).toBe(true);
  });

  it('only when plugged in: battery stops work', () => {
    const d = evaluateRunRules(DEFAULT_RUN_RULES, { ...quiet, onBattery: true }, mac, new Date());
    expect(d).toMatchObject({ mustStop: true, blocks: [{ rule: 'power' }] });
    expect(evaluateRunRules({ ...DEFAULT_RUN_RULES, power: 'any' }, { ...quiet, onBattery: true }, mac, new Date()).canStart).toBe(true);
  });

  it('thermal pressure stops work where it can be read; load only holds new work', () => {
    expect(evaluateRunRules(DEFAULT_RUN_RULES, { ...quiet, thermal: 'serious' }, mac, new Date())).toMatchObject({ mustStop: true, blocks: [{ rule: 'temperature' }] });
    expect(evaluateRunRules(DEFAULT_RUN_RULES, { ...quiet, thermal: 'serious' }, enforcementSupport('linux'), new Date()).mustStop).toBe(false);
    expect(evaluateRunRules(DEFAULT_RUN_RULES, { ...quiet, cpuLoadPct: 90 }, mac, new Date())).toMatchObject({ canStart: false, mustStop: false, blocks: [{ rule: 'load' }] });
    expect(evaluateRunRules(DEFAULT_RUN_RULES, { ...quiet, cpuLoadPct: 90 }, enforcementSupport('win32'), new Date()).canStart).toBe(true);
  });

  it('metered networks cannot be detected, so the rule never claims to block', () => {
    expect(evaluateRunRules(DEFAULT_RUN_RULES, { ...quiet, metered: true }, mac, new Date()).canStart).toBe(true);
    const lines = describeRunRules(DEFAULT_RUN_RULES, mac);
    expect(lines.find((l) => l.rule === 'Network')).toMatchObject({ enforcement: 'unavailable' });
    expect(lines.find((l) => l.rule === 'Temperature')!.note).toContain('not degrees');
    expect(describeRunRules(DEFAULT_RUN_RULES, enforcementSupport('win32')).find((l) => l.rule === 'Load')!.enforcement).toBe('unavailable');
  });

  it('schedules, including windows past midnight', () => {
    const rules: RunRules = { ...DEFAULT_RUN_RULES, when: { kind: 'schedule', windows: [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }] } };
    if (rules.when.kind !== 'schedule') throw new Error('unreachable');
    const w = rules.when.windows;
    expect(inSchedule(w, new Date('2026-11-23T23:00:00'))).toBe(true); // Monday night
    expect(inSchedule(w, new Date('2026-11-24T05:59:00'))).toBe(true); // early Tuesday
    expect(inSchedule(w, new Date('2026-11-24T12:00:00'))).toBe(false);
    expect(inSchedule(w, new Date('2026-11-23T05:00:00'))).toBe(false); // early Monday follows Sunday, not listed
    expect(evaluateRunRules(rules, { ...quiet, idleSeconds: 0 }, mac, new Date('2026-11-24T12:00:00'))).toMatchObject({ mustStop: true, blocks: [{ rule: 'when', detail: 'Outside your schedule.' }] });
  });
});
