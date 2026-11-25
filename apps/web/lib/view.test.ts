import { hasForbiddenDash, incomeClaim } from '@swarm-explorer/core';
import { describe, expect, it } from 'vitest';
import { formatDuration, joinAnd, permissionLines, rewardLine } from './view';

describe('view helpers', () => {
  it('describes rewards without income claims', () => {
    expect(rewardLine({ funding: { mode: 'volunteer' } }).text).toBe('Impact only');
    const funded = rewardLine({ funding: { mode: 'funded', creditsPerAcceptedTask: 12, poolStatus: 'empty' } });
    expect(funded).toEqual({ text: '12 credits per accepted task', note: 'Pool empty: no paid tasks until the publisher funds it.' });
    for (const s of [funded.text, funded.note ?? '']) {
      expect(incomeClaim(s)).toBeNull();
      expect(hasForbiddenDash(s)).toBe(false);
    }
  });
  it('words permissions the SPEC 11.4 way', () => {
    expect(permissionLines({ network: ['lean-lang.org', 'github.com'], scratchDiskGb: 2, gpuCompute: false, apiSpendDailyUsd: null })).toEqual([
      'Can reach lean-lang.org and github.com',
      'Up to 2 GB of working space',
    ]);
    expect(permissionLines({ network: [], scratchDiskGb: 0.5, gpuCompute: false, apiSpendDailyUsd: 1 })).toEqual([
      'No network access',
      'Up to 500 MB of working space',
      'API spend up to $1 a day, within your own caps',
    ]);
  });
  it('formats lists and durations', () => {
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
    expect(formatDuration(604_800)).toBe('7 days');
    expect(formatDuration(900)).toBe('15 minutes');
  });
});
