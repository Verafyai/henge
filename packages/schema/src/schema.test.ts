import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, normalizeDigest, signingPayload } from './canonical';
import { releaseChanges, requiresReviewAndReconsent } from './invariants';
import { bundleDigest, generatePublisherKey, signManifestV1, verifyManifestSignatures, type RegisteredKey } from './node';
import type { ManifestV1 } from './types';
import { parseManifest, validateCoreManifest, validateHarnessBundle, validateManifest } from './validate';
import { parseManifestSource } from './yaml';

const FIX = path.resolve(import.meta.dirname, '..', 'fixtures');
const read = (...p: string[]) => readFileSync(path.join(FIX, ...p), 'utf8');
const VALID = readdirSync(path.join(FIX, 'manifests', 'valid')).filter((f) => f.endsWith('.yaml'));

function load(name: string): ManifestV1 {
  const r = parseManifest(read('manifests', 'valid', name));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.manifest;
}
const clone = <T>(v: T): T => structuredClone(v);
const codes = (v: unknown) => {
  const r = validateManifest(v);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe('fixture manifests', () => {
  it.each(VALID)('%s validates against manifest v1 and the invariants', (f) => {
    const r = parseManifest(read('manifests', 'valid', f));
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it.each(VALID)('%s pins the real digest of its harness bundle', (f) => {
    const m = load(f);
    const dir = path.join(FIX, 'harnesses', m.harness.name);
    expect(m.harness.hash, 'run pnpm --filter @swarm-explorer/schema fixtures:hash').toBe(bundleDigest(dir));
    const meta = JSON.parse(readFileSync(path.join(dir, 'harness.json'), 'utf8'));
    expect(validateHarnessBundle(meta)).toEqual([]);
    expect([meta.name, meta.version, meta.runtime]).toEqual([m.harness.name, m.harness.version, m.harness.runtime]);
  });

  it('every launch swarm from SPEC 16.1 is present with its launch funding state', () => {
    const byId = Object.fromEntries(VALID.map((f) => [load(f).id, load(f)]));
    expect(Object.keys(byId).sort()).toEqual(['challenge-vaults', 'prompt-guard-red-team', 'verafy-dao-juries']);
    expect(byId['verafy-dao-juries']!.credits.funded).toBe(true);
    expect(byId['challenge-vaults']!.credits.funded).toBe(false);
    expect(byId['prompt-guard-red-team']!.credits.funded).toBe(false);
  });
});

describe("Rex's source example (SPEC 6.3)", () => {
  const src = read('manifests', 'source', 'challenge-vaults-source.yaml');
  const parsed = parseManifestSource(src);

  it('fails the core schema only on the abbreviated hash (SPEC 6.5)', () => {
    if (!parsed.ok) throw new Error('yaml');
    const issues = validateCoreManifest(parsed.value);
    expect(issues).toEqual([expect.objectContaining({ code: 'schema_pattern', path: '/harness/hash' })]);
  });

  it('passes the core schema with a full digest', () => {
    if (!parsed.ok) throw new Error('yaml');
    const v = clone(parsed.value) as { harness: { hash: string } };
    v.harness.hash = `sha256-${'a'.repeat(64)}`;
    expect(validateCoreManifest(v)).toEqual([]);
  });

  it('is not a production manifest', () => {
    const r = parseManifest(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['/manifest_version', '/harness/hash']));
  });
});

describe('manifest v1 schema', () => {
  const base = load('challenge-vaults.yaml');

  it('rejects unknown fields but accepts x- extensions at any object level', () => {
    expect(codes({ ...clone(base), surprise: 1 })).toContain('schema_additionalProperties');
    expect(codes({ ...clone(base), 'x-anything': { a: 1 } })).toEqual([]);
    const p = clone(base) as ManifestV1 & { permissions: Record<string, unknown> };
    p.permissions['x-note'] = 'ok';
    expect(codes(p)).toEqual([]);
    p.permissions['clipboard'] = true;
    expect(codes(p)).toContain('schema_additionalProperties');
  });

  it.each([
    ['*.github.com', 'wildcard'],
    ['https://github.com', 'scheme'],
    ['github.com:443', 'port'],
    ['10.0.0.1', 'IPv4 literal'],
    ['[::1]', 'IPv6 literal'],
    ['GitHub.com', 'uppercase'],
    ['localhost', 'single label'],
  ])('network allowlist refuses %s (%s)', (host) => {
    const m = clone(base);
    m.permissions.network = [host];
    expect(codes(m)).toContain('schema_pattern');
  });

  it.each([
    ['manifest_version', (m: ManifestV1) => ((m as unknown as Record<string, unknown>).manifest_version = 2), 'schema_const'],
    ['abbreviated hash', (m: ManifestV1) => (m.harness.hash = 'sha256-...' as ManifestV1['harness']['hash']), 'schema_pattern'],
    ['colon digest form', (m: ManifestV1) => (m.harness.hash = `sha256:${'a'.repeat(64)}` as ManifestV1['harness']['hash']), 'schema_pattern'],
    ['bad category', (m: ManifestV1) => ((m as unknown as Record<string, unknown>).category = 'finance'), 'schema_enum'],
    ['http results url', (m: ManifestV1) => (m.results_url = 'http://vaults.verafy.ai/results'), 'schema_pattern'],
    ['non-semver client version', (m: ManifestV1) => (m.min_client_version = 'v1'), 'schema_pattern'],
    ['zero timeout', (m: ManifestV1) => (m.task.timeout_s = 0), 'schema_minimum'],
    ['fractional reward', (m: ManifestV1) => Object.assign(m.credits, { funded: true, per_accepted_task: 1.5, pool_id: 'p' }), 'schema_type'],
    ['bad signature algorithm', (m: ManifestV1) => ((m as unknown as Record<string, unknown>).signatures = [{ key_id: 'k', algorithm: 'rsa', signature: 'AA==' }]), 'schema_const'],
  ])('rejects %s', (_label, mutate, code) => {
    const m = clone(base);
    mutate(m);
    expect(codes(m)).toContain(code);
  });
});

describe('SPEC 6.4 invariants', () => {
  const vaults = load('challenge-vaults.yaml');
  const juries = load('verafy-dao-juries.yaml');

  it.each<[string, ManifestV1, (m: ManifestV1) => void, string]>([
    ['funded without pool', vaults, (m) => Object.assign(m.credits, { funded: true, per_accepted_task: 10, pool_id: null }), 'funded_requires_pool'],
    ['funded without reward', vaults, (m) => Object.assign(m.credits, { funded: true, per_accepted_task: null, pool_id: 'pool' }), 'funded_requires_reward'],
    ['volunteer with reward', vaults, (m) => (m.credits.per_accepted_task = 5), 'volunteer_reward_must_be_null'],
    ['volunteer with pool', vaults, (m) => (m.credits.pool_id = 'pool'), 'volunteer_pool_must_be_null'],
    ['class policy without class', vaults, (m) => delete m.models.class, 'class_policy_requires_class'],
    ['diverse without panel rules', juries, (m) => delete m.models.diversity, 'diverse_requires_panel_rules'],
    ['diverse without panel verifier', juries, (m) => (m.verification = ['publisher-review']), 'diverse_requires_panel_verifier'],
    ['diversity on a non-diverse policy', vaults, (m) => (m.models.diversity = { min_families: 2, min_accounts: 2 }), 'diversity_without_diverse_policy'],
    ['jury without panel size', juries, (m) => (m.verification_config.jury_panel_size = null), 'jury_requires_panel_size'],
    ['known answers without rate', vaults, (m) => (m.verification = ['machine-check', 'known-answers']), 'known_answers_requires_rate'],
    ['redundancy without count', vaults, (m) => (m.verification = ['redundancy']), 'redundancy_requires_count'],
    ['more families than jurors', juries, (m) => (m.models.diversity!.min_families = 4), 'panel_smaller_than_families'],
    ['pass above tasks', vaults, (m) => (m.qualification = { tasks: 2, pass: 3 }), 'qualification_pass_exceeds_tasks'],
    ['model provider domain', vaults, (m) => m.permissions.network.push('api.anthropic.com'), 'network_lists_model_provider'],
    ['provider apex domain', vaults, (m) => m.permissions.network.push('openrouter.ai'), 'network_lists_model_provider'],
    ['API spend without API', load('prompt-guard-red-team.yaml'), (m) => (m.permissions.api_spend_daily_usd = 1), 'api_spend_without_api'],
    ['healthcare allowing sensitive data', vaults, (m) => Object.assign(m, { category: 'healthcare', data_policy: { ...m.data_policy, sensitive_data_prohibited: false } }), 'healthcare_requires_sensitive_prohibited'],
    ['healthcare with private inputs', vaults, (m) => Object.assign(m, { category: 'healthcare', data_policy: { ...m.data_policy, public_inputs: false } }), 'healthcare_requires_public_inputs'],
    ['self-hosted without key', vaults, (m) => (m.coordinator = { mode: 'self_hosted', url: 'https://coord.example.org', public_key: null }), 'self_hosted_requires_key'],
    ['self-hosted without url', vaults, (m) => (m.coordinator = { mode: 'self_hosted', url: null, public_key: 'abc' }), 'self_hosted_requires_url'],
    ['hosted with a url', vaults, (m) => (m.coordinator.url = 'https://coord.example.org'), 'hosted_coordinator_fields'],
  ])('%s', (_label, base, mutate, code) => {
    const m = clone(base);
    mutate(m);
    expect(codes(m)).toContain(code);
  });

  it('a lookalike domain is not mistaken for a provider', () => {
    const m = clone(vaults);
    m.permissions.network.push('notanthropic.com');
    expect(codes(m)).toEqual([]);
  });
});

describe('YAML parsing', () => {
  it('refuses duplicate keys', () => {
    expect(parseManifestSource('id: a\nid: b\n')).toMatchObject({ ok: false, issues: [{ code: 'yaml_syntax' }] });
  });
  it('refuses aliases', () => {
    expect(parseManifestSource('a: &x [1, 2]\nb: *x\n')).toMatchObject({ ok: false, issues: [{ code: 'yaml_alias' }] });
  });
  it('does not apply merge keys or custom tags', () => {
    expect(parseManifestSource('a: !!js/function "x"\n')).toMatchObject({ ok: false, issues: [{ code: 'yaml_syntax' }] });
    const merged = parseManifestSource('base: &b { x: 1 }\nm: { <<: *b }\n');
    expect(merged.ok).toBe(false);
  });
  it('accepts JSON, which is YAML', () => {
    const json = JSON.stringify(load('prompt-guard-red-team.yaml'));
    expect(parseManifest(json).ok).toBe(true);
  });
  it('refuses oversized sources', () => {
    expect(parseManifestSource(`x: "${'a'.repeat(300 * 1024)}"`)).toMatchObject({ ok: false, issues: [{ code: 'too_large' }] });
  });
});

describe('canonical JSON (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], 'é': 0, A: { z: 1, y: 2 } })).toBe('{"A":{"y":2,"z":1},"a":[true,null,"x"],"b":1,"é":0}');
  });
  it('writes numbers the RFC 8785 way', () => {
    expect(canonicalJson([1.0, 0.5, 1e21, -0, 100])).toBe('[1,0.5,1e+21,0,100]');
  });
  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
  });
  it('is independent of key order and YAML formatting', () => {
    const m = load('verafy-dao-juries.yaml');
    const reordered = Object.fromEntries(Object.entries(m).reverse());
    expect(signingPayload(reordered)).toBe(signingPayload(m as unknown as Record<string, unknown>));
  });
  it('normalizes the API colon form to the manifest digest form', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizeDigest(`sha256:${hex}`)).toBe(`sha256-${hex}`);
    expect(normalizeDigest(`SHA256-${hex.toUpperCase()}`)).toBe(`sha256-${hex}`);
    expect(normalizeDigest('sha256-...')).toBeNull();
    expect(normalizeDigest(`md5-${hex}`)).toBeNull();
  });
});

describe('publisher signatures (SPEC 6.5, 11.6)', () => {
  const key = generatePublisherKey('verafy-test-1');
  const registry = new Map<string, RegisteredKey>([[key.keyId, { keyId: key.keyId, publisher: 'verafy.ai', publicKey: key.publicKey, status: 'active' }]]);
  const lookup = (id: string) => registry.get(id);
  const signed = signManifestV1(load('challenge-vaults.yaml'), key);

  it('signs the canonical form and verifies against the registry', () => {
    expect(validateManifest(signed).ok).toBe(true);
    expect(verifyManifestSignatures(signed, lookup)).toEqual({ ok: true, keyId: 'verafy-test-1' });
  });
  it('re-signing replaces the same key instead of stacking', () => {
    expect(signManifestV1(signed, key).signatures).toHaveLength(1);
  });
  it('refuses unsigned, tampered, unknown, revoked and foreign-publisher manifests', () => {
    const { signatures: _s, ...unsigned } = signed;
    expect(verifyManifestSignatures(unsigned as ManifestV1, lookup)).toEqual({ ok: false, reason: 'unsigned' });

    const tampered = clone(signed);
    tampered.permissions.network.push('evil.example');
    expect(verifyManifestSignatures(tampered, lookup)).toEqual({ ok: false, reason: 'bad_signature' });

    expect(verifyManifestSignatures(signed, () => undefined)).toEqual({ ok: false, reason: 'unknown_key' });
    expect(verifyManifestSignatures(signed, (id) => ({ ...registry.get(id)!, status: 'revoked' }))).toEqual({ ok: false, reason: 'revoked_key' });
    expect(verifyManifestSignatures(signed, (id) => ({ ...registry.get(id)!, publisher: 'someone-else.example' }))).toEqual({ ok: false, reason: 'wrong_publisher' });
  });
  it('a signature from another key cannot be relabeled as the publisher key', () => {
    const other = generatePublisherKey('attacker');
    const forged = signManifestV1(load('challenge-vaults.yaml'), other);
    forged.signatures![0]!.key_id = key.keyId;
    expect(verifyManifestSignatures(forged, lookup)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('release changes (SPEC 6.4, 11.4)', () => {
  const v1 = load('challenge-vaults.yaml');
  it.each<[string, (m: ManifestV1) => void, string, boolean]>([
    ['new network domain', (m) => m.permissions.network.push('example.org'), 'network', true],
    ['bigger scratch disk', (m) => (m.permissions.scratch_disk_gb = 4), 'permissions', true],
    ['new harness version', (m) => (m.harness.version = '1.4.1'), 'harness', true],
    ['coordinator moves', (m) => (m.coordinator = { mode: 'self_hosted', url: 'https://c.example.org', public_key: 'k' }), 'coordinator', true],
    ['data retention', (m) => (m.data_policy.retention_days = 30), 'data_policy', true],
    ['economic terms', (m) => Object.assign(m.credits, { funded: true, per_accepted_task: 3, pool_id: 'p' }), 'economics', true],
    ['summary text only', (m) => (m.summary = 'New words'), 'other', false],
  ])('%s', (_l, mutate, change, reconsent) => {
    const v2 = clone(v1);
    mutate(v2);
    const c = releaseChanges(v1, v2);
    expect(c).toContain(change);
    expect(requiresReviewAndReconsent(c)).toBe(reconsent);
  });
  it('reordering network domains is not a change', () => {
    const a = clone(v1);
    const b = clone(v1);
    b.permissions.network.reverse();
    expect(releaseChanges(a, b)).toEqual([]);
  });
});
