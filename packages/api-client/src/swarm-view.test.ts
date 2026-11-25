import { describe, expect, it } from 'vitest';
import type { SwarmDetail } from './contracts';
import { acceptanceText, permissionLines, swarmQuestions } from './swarm-view';

const Z = `sha256-${'0'.repeat(64)}`;
const detail = {
  slug: 'x',
  name: 'X',
  summary: 'Find things',
  category: 'security',
  publisher: { slug: 'p', name: 'P', badge: 'none' },
  featured: false,
  funding: { mode: 'volunteer' },
  verification: ['machine-check'],
  models: { policy: 'any', classes: [], apiAllowed: false },
  harness: { name: 'h', version: '1.0.0', runtime: 'wasm' },
  permissions: { network: [], scratchDiskGb: 0.5, gpuCompute: false, apiSpendDailyUsd: null },
  release: { id: '00000000-0000-7000-8000-000000000000', manifestHash: Z, permissionsHash: Z, publishedAt: null, harnessHash: Z, minClientVersion: '0.1.0' },
  resultsUrl: 'https://example.com',
  qualification: { tasks: 3, pass: 2 },
  task: { timeoutS: 600, maxParallelPerNode: 1, urgentAllowed: false },
  verificationConfig: { knownAnswerRate: null, redundancyCount: null, juryPanelSize: null, pendingWindowS: 604800 },
  dataPolicy: { publicInputs: true, retentionDays: 365, sensitiveDataProhibited: true },
  acceptance: { status: 'not_enough_history' },
  outcomes: [],
  trust: { releaseReviewed: true, harnessReviewed: true, signatureKeyId: 'k1', openReports: 0 },
  manifest: {},
} satisfies SwarmDetail;

describe('swarm page questions (SPEC 4.2)', () => {
  it('asks the six questions in source order', () => {
    expect(swarmQuestions(detail).map((q) => q.id)).toEqual(['purpose', 'outcomes', 'requirements', 'rewards', 'verification', 'trust']);
  });

  it('never fakes an acceptance rate or outcomes', () => {
    const q = swarmQuestions(detail);
    expect(q[3]!.facts).toContainEqual({ label: 'Acceptance rate', value: 'Not enough history yet' });
    expect(q[1]!.note).toMatch(/^No verified results yet/);
    expect(acceptanceText({ status: 'measured', acceptedBp: 8125, sample: 160, from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' })).toBe('81.3% of 160 results, 2026-10-01 to 2026-10-31');
  });

  it('words permissions as SPEC 11.4 does', () => {
    expect(permissionLines({ network: ['lean-lang.org', 'github.com'], scratchDiskGb: 2, gpuCompute: false, apiSpendDailyUsd: 1 })).toEqual([
      'Can reach lean-lang.org and github.com',
      'Up to 2 GB of working space',
      'API spend up to $1 a day, within your own caps',
    ]);
  });
});
