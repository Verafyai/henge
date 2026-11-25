import { describe, expect, it } from 'vitest';
import { matchPlanned, PLANNED_ROUTES } from './api-plan';

describe('planned API routes (SPEC 13)', () => {
  it('matches parameterized paths by method', () => {
    expect(matchPlanned('POST', '/leases/abc/abandon')?.milestone).toBe('M5');
    expect(matchPlanned('GET', '/leases/abc/abandon')).toBeUndefined();
    expect(matchPlanned('POST', '/leases/abc/abandon/extra')).toBeUndefined();
    expect(matchPlanned('POST', '/swarms/challenge-vaults/tasks:batch')?.milestone).toBe('M5');
  });
  it('every planned route names a SPEC 16.4 milestone', () => {
    for (const r of PLANNED_ROUTES) expect(r.milestone).toMatch(/^M(1[0-2]|[1-9])$/);
  });
  it('lists no cash-out or transfer endpoint (SPEC 9.4)', () => {
    for (const r of PLANNED_ROUTES) expect(r.path).not.toMatch(/withdraw|cash|payout|transfer/i);
  });
});
