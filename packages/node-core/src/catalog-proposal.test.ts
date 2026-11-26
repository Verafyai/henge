import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Rex's call (2026-11-25): no moving tags in the catalog, because a moving tag defeats the point of pinning. */
const proposal = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/catalog/proposal-2026-11-25.json'), 'utf8')) as {
  models: Array<{ sourceRef: string; contentHash: string; sizeBytes: number; license: string; tier: string }>;
};

describe('approved model catalog', () => {
  it('has the five approved models', () => {
    expect(proposal.models.map((m) => m.sourceRef)).toEqual([
      'phi4-mini:3.8b-q4_K_M',
      'qwen2.5:7b-instruct-q4_K_M',
      'mistral-nemo:12b-instruct-2407-q4_K_M',
      'phi4:14b-q4_K_M',
      'mistral-small:24b-instruct-2501-q4_K_M',
    ]);
  });

  it('pins exact quantization tags only, with a real digest and size', () => {
    for (const m of proposal.models) {
      expect(m.sourceRef, m.sourceRef).toMatch(/:[^:]*-q\d_[A-Z0-9_]+$/i);
      expect(m.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(m.sizeBytes).toBeGreaterThan(0);
      expect(['MIT', 'Apache-2.0']).toContain(m.license);
    }
  });

  it('covers 8, 16 and 24 GB machines', () => {
    expect(new Set(proposal.models.map((m) => m.tier))).toEqual(new Set(['8 GB', '16 GB', '24 GB']));
  });
});
