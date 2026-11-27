import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtinGlyphs, buildFromTemplate, HengeLibrary, hengeLinkTarget } from './henge-library';
import type { Participation } from '../shared/henge';

const EXAMPLE = path.resolve(__dirname, '../../../../packages/schema/fixtures/henge/valid/example.henge.yaml');
const exampleUrl = pathToFileURL(EXAMPLE).href;

let dir: string;
let lib: HengeLibrary;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'henges-test-'));
  lib = new HengeLibrary({ dir, allowFileUrls: true, now: () => 1 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const participation: Participation = { role: 'worker', model: null, dailyCapCents: 500, cpuCores: 2, schedule: 'idle_only', reconsent: true };
const attest = ['I will not look up the outcome of a question while answering it.', 'My node may be paused or removed by maintainers under GOVERNANCE.md.'];

describe('henge links', () => {
  it('accepts https, henge://add and refuses invite links until the community service exists', () => {
    expect(hengeLinkTarget('https://example.org/a.henge.yaml')).toEqual({ url: 'https://example.org/a.henge.yaml' });
    expect(hengeLinkTarget(`henge://add?url=${encodeURIComponent('https://example.org/a.henge.yaml')}`)).toEqual({ url: 'https://example.org/a.henge.yaml' });
    const invite = hengeLinkTarget('https://henge.verafy.ai/i/abc123');
    expect('error' in invite && invite.error.ok === false && invite.error.code).toBe('invite_unavailable');
    const extra = hengeLinkTarget('henge://add?url=https://example.org/a&join=1');
    expect('error' in extra).toBe(true);
  });

  it('refuses file URLs unless the unpackaged test hook is on', async () => {
    const strict = new HengeLibrary({ dir, allowFileUrls: false });
    expect(await strict.resolve(exampleUrl)).toMatchObject({ ok: false, code: 'not_https' });
  });
});

describe('joining', () => {
  it('resolves the example, then joins it with a required daily cap and every rule accepted', async () => {
    const r = await lib.resolve(exampleUrl);
    if (!r.ok) throw new Error(r.message);
    expect(r.henge.name).toBe('Resolved Forecasts (example)');
    const noCap = lib.join({ url: exampleUrl, bundleDigest: r.pin.bundle_digest, participation: { ...participation, dailyCapCents: null }, attested: attest });
    expect(noCap.ok === false && noCap.issues.map((i) => i.code)).toEqual(['budget_daily_cap_required']);
    const missing = lib.join({ url: exampleUrl, bundleDigest: r.pin.bundle_digest, participation, attested: attest.slice(0, 1) });
    expect(missing.ok === false && missing.issues.map((i) => i.code)).toEqual(['attest_missing']);
    const ok = lib.join({ url: exampleUrl, bundleDigest: r.pin.bundle_digest, participation, attested: attest });
    expect(ok.ok && ok.henge.status).toBe('awaiting_admission');
    expect(lib.list().map((h) => h.key)).toEqual(['example-org--resolved-forecasts']);
    expect(lib.source('example-org--resolved-forecasts')).toContain('Resolved Forecasts');
    expect(lib.leave('example-org--resolved-forecasts')).toBe(true);
    expect(lib.list()).toEqual([]);
  });

  it('refuses a join whose digest differs from what was reviewed', async () => {
    await lib.resolve(exampleUrl);
    const r = lib.join({ url: exampleUrl, bundleDigest: `sha256-${'0'.repeat(64)}`, participation, attested: attest });
    expect(r.ok === false && r.issues[0]!.code).toBe('changed');
  });
});

describe('creating and Glyphs', () => {
  const input = { template: 'forecasting' as const, name: 'Tide Watchers', icon: 'TW', tagline: 'Watch the tides.', channels: ['general', 'tasks'], glyphs: ['verafy/governance', 'verafy/moderation'], storage: 'local' as const, ownerHandle: 'river' };

  it('the template validates with Governance and Moderation', () => {
    const r = lib.create(input);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.henge.status).toBe('owner');
    expect(r.henge.henge.glyphs?.map((g) => g.use)).toEqual(['verafy/governance@^1.0.0', 'verafy/moderation@^1.0.0']);
    // Governance creates #proposals.
    expect(r.henge.henge.community?.categories?.flatMap((c) => c.channels.map((x) => x.id))).toContain('proposals');
    expect(buildFromTemplate(input).governance.holders.owner).toEqual(['river']);
  });

  it('refuses a grant beyond what the Glyph requests, and adds it when the grant fits', () => {
    const r = lib.create(input);
    if (!r.ok) throw new Error('create failed');
    const strategy = builtinGlyphs().find((g) => g.id === 'verafy/strategy')!;
    const over = lib.planGlyphAdd({ key: r.henge.key, glyphId: strategy.id, granted: [...strategy.permissions.requests, 'treasury:pay'] });
    expect(over.issues.map((i) => i.code)).toContain('granted_exceeds_requests');
    expect(lib.addGlyph({ key: r.henge.key, glyphId: strategy.id, granted: [...strategy.permissions.requests, 'treasury:pay'] }).ok).toBe(false);
    const fit = lib.addGlyph({ key: r.henge.key, glyphId: strategy.id, granted: strategy.permissions.requests });
    expect(fit.ok && fit.mode).toBe('added');
    expect(lib.get(r.henge.key)?.henge.version).toBe('0.1.1');
  });

  it('vote-gated Runes are returned for a proposal and not applied; maintainer Runes apply for the owner', () => {
    const r = lib.create(input);
    if (!r.ok) throw new Error('create failed');
    const res = lib.applyRunes({ key: r.henge.key, glyphId: 'verafy/governance', changes: { 'voting.method': 'supermajority', 'proposals.who_can_open': ['maintainer'] } });
    if (!res.ok) throw new Error(JSON.stringify(res.issues));
    expect(res.proposal).toEqual({ 'voting.method': 'supermajority' });
    expect(res.applied).toEqual(['proposals.who_can_open']);
    const entry = lib.get(r.henge.key)!.henge.glyphs!.find((g) => g.use.startsWith('verafy/governance'))!;
    expect(entry.runes?.['voting.method']).toBeUndefined();
    expect(entry.runes?.['proposals.who_can_open']).toEqual(['maintainer']);
  });

  it('a joined member proposes adding a Glyph when the file needs a vote for glyphs.add', async () => {
    const v = await lib.resolve(exampleUrl);
    if (!v.ok) throw new Error('resolve');
    lib.join({ url: exampleUrl, bundleDigest: v.pin.bundle_digest, participation, attested: attest });
    const plan = lib.planGlyphAdd({ key: 'example-org--resolved-forecasts', glyphId: 'verafy/strategy', granted: [] });
    expect(plan.mode).toBe('propose');
    expect(plan.issues.map((i) => i.code)).toEqual(['glyph_already_added']);
  });
});
