import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client';
import { leaseResponseSchema, runRecordSchema, type SwarmDetail } from './contracts';

const D = (c: string) => `sha256-${c.repeat(64)}`;

const swarm: SwarmDetail = {
  slug: 'challenge-vaults',
  name: 'Challenge Vaults',
  summary: 'Search for Lean proofs of open Erdos problems',
  category: 'mathematics',
  publisher: { slug: 'verafy.ai', name: 'Verafy', badge: 'pending' },
  featured: true,
  funding: { mode: 'volunteer' },
  verification: ['machine-check'],
  models: { policy: 'class', classes: ['code-7b-plus'], apiAllowed: true },
  harness: { name: 'lean-prover', version: '1.4.0', runtime: 'container' },
  permissions: { network: ['lean-lang.org', 'github.com'], scratchDiskGb: 2, gpuCompute: false, apiSpendDailyUsd: null },
  release: {
    id: '01936f3e-0000-7000-8000-000000000001',
    manifestHash: D('a'),
    permissionsHash: D('b'),
    publishedAt: '2026-11-24T00:00:00.000Z',
    harnessHash: D('c'),
    minClientVersion: '0.1.0',
  },
  resultsUrl: 'https://vaults.verafy.ai/results',
  qualification: { tasks: 3, pass: 2 },
  task: { timeoutS: 900, maxParallelPerNode: 1, urgentAllowed: false },
  verificationConfig: { knownAnswerRate: null, redundancyCount: null, juryPanelSize: null, pendingWindowS: 604800 },
  dataPolicy: { publicInputs: true, retentionDays: 365, sensitiveDataProhibited: true },
  acceptance: { status: 'not_enough_history' },
  outcomes: [],
  trust: { releaseReviewed: true, harnessReviewed: true, signatureKeyId: 'k1', openReports: 0 },
  manifest: { id: 'challenge-vaults' },
};

function fakeFetch(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return async (input, init) => {
    seen.push(new Request(input as string, init));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

describe('api client', () => {
  it('parses a swarm under /v1 and sends the bearer token', async () => {
    const seen: Request[] = [];
    const api = createApiClient({ baseUrl: 'http://x/', fetch: fakeFetch(200, swarm, seen), getAccessToken: () => 't0k' });
    const s = await api.getSwarm('challenge-vaults');
    expect(s.funding).toEqual({ mode: 'volunteer' });
    expect(seen[0]?.url).toBe('http://x/v1/swarms/challenge-vaults');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer t0k');
  });

  it('builds query strings and skips empty values', async () => {
    const seen: Request[] = [];
    const api = createApiClient({ baseUrl: 'http://x', fetch: fakeFetch(200, { items: [] }, seen) });
    await api.listSwarms({ category: 'science' });
    await api.listSwarms();
    expect(seen.map((r) => r.url)).toEqual(['http://x/v1/swarms?category=science', 'http://x/v1/swarms']);
  });

  it('surfaces the error envelope with details', async () => {
    const api = createApiClient({ baseUrl: 'http://x', fetch: fakeFetch(404, { error: { code: 'not_found', message: 'No such swarm.', details: { slug: 'x' } } }) });
    await expect(api.getSwarm('x')).rejects.toMatchObject({ name: 'ApiError', status: 404, code: 'not_found', details: { slug: 'x' } });
  });

  it('refuses responses that do not match the contract', async () => {
    const api = createApiClient({ baseUrl: 'http://x', fetch: fakeFetch(200, { ...swarm, funding: { mode: 'funded' } }) });
    await expect(api.getSwarm('challenge-vaults')).rejects.toBeInstanceOf(ApiError);
  });

  it('a funded swarm must state a positive whole credit rate', async () => {
    const ok = { ...swarm, funding: { mode: 'funded', creditsPerAcceptedTask: 12, poolStatus: 'empty' } };
    const api = createApiClient({ baseUrl: 'http://x', fetch: fakeFetch(200, ok) });
    await expect(api.getSwarm('s')).resolves.toMatchObject({ funding: { creditsPerAcceptedTask: 12 } });
    const frac = { ...swarm, funding: { mode: 'funded', creditsPerAcceptedTask: 1.5, poolStatus: 'empty' } };
    await expect(createApiClient({ baseUrl: 'http://x', fetch: fakeFetch(200, frac) }).getSwarm('s')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('task protocol contracts (SPEC 13.3)', () => {
  const lease = {
    lease_id: '01936f3e-0000-7000-8000-000000000001',
    task_id: '01936f3e-0000-7000-8000-000000000002',
    swarm_release_id: '01936f3e-0000-7000-8000-000000000003',
    deadline_at: '2026-11-24T12:15:00.000Z',
    harness: { version: '1.4.0', hash: D('a') },
    model_requirement: { policy: 'class', allowed_classes: ['code-7b-plus'] },
    input: { uri: 'https://coord.example.org/inputs/1?sig=x', sha256: D('b') },
    output_schema_hash: D('c'),
    reward: { funded: false, credits: null },
    permissions_hash: D('d'),
  };
  it('accepts zero or one lease', () => {
    expect(leaseResponseSchema.parse({ lease: null })).toEqual({ lease: null });
    expect(leaseResponseSchema.parse({ lease }).lease?.reward).toEqual({ funded: false, credits: null });
  });
  it('volunteer leases carry no credits and funded leases carry whole credits', () => {
    expect(leaseResponseSchema.safeParse({ lease: { ...lease, reward: { funded: false, credits: 5 } } }).success).toBe(false);
    expect(leaseResponseSchema.safeParse({ lease: { ...lease, reward: { funded: true, credits: null } } }).success).toBe(false);
    expect(leaseResponseSchema.safeParse({ lease: { ...lease, reward: { funded: true, credits: 12 } } }).success).toBe(true);
  });
  it('digests must use the sha256-<hex> form, not the colon form', () => {
    expect(leaseResponseSchema.safeParse({ lease: { ...lease, output_schema_hash: `sha256:${'c'.repeat(64)}` } }).success).toBe(false);
  });
  it('run records require integer micros and nullable token counts', () => {
    const rec = {
      lease_id: lease.lease_id,
      node_id: lease.task_id,
      model: { source: 'local', claimed_id: 'qwen2.5-coder-7b', artifact_hash: D('e') },
      harness_hash: D('a'),
      tokens: { input: null, output: 120 },
      elapsed_ms: 5400,
      api_cost: { reported_usd_micros: null, provider_request_ids: [] },
      output_sha256: D('f'),
      client_version: '0.1.0',
      signature: 'sig',
    };
    expect(runRecordSchema.safeParse(rec).success).toBe(true);
    expect(runRecordSchema.safeParse({ ...rec, api_cost: { reported_usd_micros: 1.5, provider_request_ids: [] } }).success).toBe(false);
  });
});
