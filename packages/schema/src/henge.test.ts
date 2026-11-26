import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { canonicalJson } from './canonical';
import { checkGlyphGrant, parseGlyph, planRuneChanges, satisfiesRange, validateGlyph } from './glyph-validate';
import { extractZip } from './henge-archive';
import { hengeBundleDigest, hengeFileDigest, sha256Hex } from './henge-digest';
import { sanitizeLandingMarkdown } from './henge-landing';
import { classifyHengeUrl, githubBlobToRaw, HENGE_MANIFEST_MAX_BYTES, isPublicAddress, resolveHenge, type ResolveDeps } from './henge-resolve';
import { hengeToManifestCandidate, toManifestV1, type ManifestContext } from './henge-to-manifest';
import type { GlyphManifestV1, HengeV1 } from './henge-v1';
import { checkHengeUpdate, checkJoinReadiness, parseHenge, validateHenge, validateHengeBundle } from './henge-validate';
import { validateManifest } from './validate';
import { parseManifestSource } from './yaml';

const FIX = path.resolve(import.meta.dirname, '..', 'fixtures');
const read = (...p: string[]) => readFileSync(path.join(FIX, ...p), 'utf8');
const yaml = (src: string): unknown => {
  const r = parseManifestSource(src);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};
const clone = <T>(v: T): T => structuredClone(v);
const te = new TextEncoder();
const bytes = (s: string) => te.encode(s);

const EXAMPLE_SRC = read('henge', 'valid', 'example.henge.yaml');
const EXAMPLE = yaml(EXAMPLE_SRC) as HengeV1;
const BUILTIN_FILES = readdirSync(path.join(FIX, 'glyphs', 'verafy')).filter((f) => f.endsWith('.glyph.yaml'));
const BUILTINS: Record<string, GlyphManifestV1> = Object.fromEntries(
  BUILTIN_FILES.map((f) => {
    const r = parseGlyph(read('glyphs', 'verafy', f));
    if (!r.ok) throw new Error(`${f}: ${JSON.stringify(r.issues)}`);
    return [f.replace('.glyph.yaml', ''), r.glyph];
  }),
);
const MANIFESTS = Object.values(BUILTINS);

/* JSON Pointer edits used by the fixtures. */
const unescape = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');
function walk(obj: unknown, ptr: string): [Record<string, unknown> | unknown[], string] {
  const parts = ptr.split('/').slice(1).map(unescape);
  let cur = obj as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  return [cur, parts[parts.length - 1]!];
}
function applyEdits<T>(base: T, set?: Record<string, unknown>, unset?: string[]): T {
  const v = clone(base);
  for (const [ptr, val] of Object.entries(set ?? {})) {
    const [parent, key] = walk(v, ptr);
    (parent as Record<string, unknown>)[key] = val;
  }
  for (const ptr of unset ?? []) {
    const [parent, key] = walk(v, ptr);
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
  }
  return v;
}
const codes = (r: { ok: boolean; issues?: { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code));
const fileMap = (h: unknown, extra: Record<string, string> = {}) => new Map<string, Uint8Array>([['henge.yaml', bytes(stringify(h))], ...Object.entries(extra).map(([k, v]) => [k, bytes(v)] as [string, Uint8Array])]);

describe('henge v1 fixtures', () => {
  it('example.henge.yaml validates against the schema and every invariant, checked against the built-in Glyphs', () => {
    const r = parseHenge(EXAMPLE_SRC, { glyphManifests: MANIFESTS });
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (r.ok) expect(r.unchecked).toEqual([]);
  });

  it('without Glyph manifests the Glyph cross-checks are reported as unchecked, not passed silently', () => {
    const r = parseHenge(EXAMPLE_SRC);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unchecked).toHaveLength(6);
  });

  it.each(BUILTIN_FILES)('built-in Glyph %s validates against glyph-v1.schema.json and the 7.3 rules', (f) => {
    expect(codes(parseGlyph(read('glyphs', 'verafy', f)))).toEqual([]);
  });

  it('the six built-in Glyphs of 7.1 are present', () => {
    expect(Object.values(BUILTINS).map((g) => g.id).sort()).toEqual(['verafy/benchmark', 'verafy/governance', 'verafy/learnings', 'verafy/moderation', 'verafy/strategy', 'verafy/treasury']);
  });

  it('the example bundle (henge.yaml plus text files) validates as a bundle', () => {
    const files = fileMap(EXAMPLE, { 'strategies/base-rate-first.md': '# Base rate first (example)\n', 'learnings/entry.schema.json': '{}', 'benchmarks/scorer/score.py': 'print(1)\n' });
    expect(codes(validateHengeBundle(files, { glyphManifests: MANIFESTS }))).toEqual([]);
  });

  it('member settings with a daily cap may join', () => {
    expect(checkJoinReadiness(EXAMPLE, { daily_cap: 5 })).toEqual([]);
  });

  it('an unchanged update needs no re-consent and no vote', () => {
    expect(checkHengeUpdate(EXAMPLE, clone(EXAMPLE))).toEqual({ issues: [], reconsent: [], voteRequired: [] });
  });

  it('kind template is reserved', () => {
    expect(codes(validateHenge({ ...clone(EXAMPLE), kind: 'template' }, { glyphManifests: MANIFESTS }))).toContain('kind_template_reserved');
  });

  it('rejects unknown top-level fields but accepts x- extensions', () => {
    expect(codes(validateHenge({ ...clone(EXAMPLE), surprise: 1 }))).toContain('schema_additionalProperties');
    expect(codes(validateHenge({ ...clone(EXAMPLE), 'x-note': 1 }))).toEqual([]);
  });

  it('refuses a landing accent that fails WCAG AA on the page background', () => {
    const h = clone(EXAMPLE);
    h.landing.accent = '#202020';
    expect(codes(validateHenge(h))).toContain('landing_accent_contrast');
  });
});

interface HengeFixture {
  check: 'validate' | 'bundle' | 'update' | 'join';
  expect?: string;
  expect_reconsent?: string[];
  set?: Record<string, unknown>;
  unset?: string[];
  files?: Record<string, string>;
  previous?: { set?: Record<string, unknown>; files?: Record<string, string> };
  member?: { daily_cap?: number | null };
}

const HENGE_INVALID = readdirSync(path.join(FIX, 'henge', 'invalid')).filter((f) => f.endsWith('.yaml'));

describe('6.4 invariants: one failing fixture each', () => {
  it.each(HENGE_INVALID)('%s', (f) => {
    const fx = yaml(read('henge', 'invalid', f)) as HengeFixture;
    const next = applyEdits(EXAMPLE, fx.set, fx.unset);
    let got: string[] = [];
    if (fx.check === 'validate') got = codes(validateHenge(next, { glyphManifests: MANIFESTS }));
    else if (fx.check === 'bundle') got = codes(validateHengeBundle(fileMap(next, fx.files), { glyphManifests: MANIFESTS }));
    else if (fx.check === 'join') got = checkJoinReadiness(next, fx.member ?? {}).map((i) => i.code);
    else {
      const prev = applyEdits(EXAMPLE, fx.previous?.set);
      const files = fx.files || fx.previous?.files ? { previous: fileMap(prev, fx.previous?.files), next: fileMap(next, fx.files) } : undefined;
      const r = checkHengeUpdate(prev, next, files);
      got = r.issues.map((i) => i.code);
      if (fx.expect_reconsent) expect(r.reconsent).toEqual(fx.expect_reconsent);
    }
    if (fx.expect) expect(got).toContain(fx.expect);
    else expect(got).toEqual([]);
  });

  it('a field that v1 does not define (participation.limits) falls back to its parent, so a budget change still needs re-consent', () => {
    const next = applyEdits(EXAMPLE, { '/version': '0.2.0', '/participation/budget/hard_stop': false });
    expect(checkHengeUpdate(EXAMPLE, next).reconsent).toEqual(['participation.limits']);
  });

  it('every change bumps the version', () => {
    const next = applyEdits(EXAMPLE, { '/summary': 'Changed summary (example).' });
    expect(checkHengeUpdate(EXAMPLE, next).issues.map((i) => i.code)).toEqual(['version_not_bumped']);
  });

  it('a new id may change the constitution', () => {
    const next = applyEdits(EXAMPLE, { '/id': 'example-org/resolved-forecasts-2', '/version': '1.0.0', '/governance/constitution/immutable': ['A new clause (example).'] });
    expect(checkHengeUpdate(EXAMPLE, next).issues).toEqual([]);
  });
});

interface GlyphFixture {
  check: 'manifest' | 'grant' | 'henge' | 'runes';
  base?: string;
  expect?: string;
  set?: Record<string, unknown>;
  grant?: { granted: string[]; previouslyGranted?: string[]; memberCount: number; votePassed: boolean };
  changes?: Record<string, unknown>;
  expect_proposal?: string[];
  expect_direct?: string[];
}

const GLYPH_INVALID = readdirSync(path.join(FIX, 'glyphs', 'invalid')).filter((f) => f.endsWith('.yaml'));

describe('7.3 scope rules and Runes: one failing fixture each', () => {
  it.each(GLYPH_INVALID)('%s', (f) => {
    const fx = yaml(read('glyphs', 'invalid', f)) as GlyphFixture;
    let got: string[] = [];
    if (fx.check === 'henge') got = codes(validateHenge(applyEdits(EXAMPLE, fx.set), { glyphManifests: MANIFESTS }));
    else {
      const glyph = applyEdits(BUILTINS[fx.base!]!, fx.set);
      if (fx.check === 'manifest') got = codes(validateGlyph(glyph));
      else if (fx.check === 'grant') got = checkGlyphGrant({ glyph, ...fx.grant! }).map((i) => i.code);
      else {
        const plan = planRuneChanges(glyph, fx.changes!, { roles: Object.keys(EXAMPLE.governance.roles) });
        expect(plan.issues).toEqual([]);
        expect(Object.keys(plan.proposal)).toEqual(fx.expect_proposal);
        expect(Object.keys(plan.direct)).toEqual(fx.expect_direct);
        expect(plan.approvers).toEqual({ 'proposals.who_can_open': 'maintainer' });
        return;
      }
    }
    expect(got).toContain(fx.expect);
  });

  it('treasury:pay may be granted without a vote when the owner is the only member, or after a vote passes', () => {
    const glyph = BUILTINS.treasury!;
    expect(checkGlyphGrant({ glyph, granted: ['treasury:pay'], memberCount: 1, votePassed: false })).toEqual([]);
    expect(checkGlyphGrant({ glyph, granted: ['treasury:pay'], memberCount: 5, votePassed: true })).toEqual([]);
    expect(checkGlyphGrant({ glyph, granted: ['treasury:pay'], previouslyGranted: ['treasury:pay'], memberCount: 5, votePassed: false })).toEqual([]);
  });

  it('refusal for a grant that exceeds requests is a clear message (7.7)', () => {
    const [issue] = checkGlyphGrant({ glyph: BUILTINS.governance!, granted: ['treasury:pay'], memberCount: 1, votePassed: false });
    expect(issue!.message).toBe("Governance Glyph does not request treasury:pay, so it cannot be granted. A Henge may grant only scopes listed in the Glyph's permissions.requests.");
  });

  it('network scopes must name an exact public domain that is not a model provider', () => {
    const g = applyEdits(BUILTINS.governance!, { '/permissions/requests/6': 'network:api.anthropic.com' });
    expect(codes(validateGlyph(g))).toContain('scope_network_model_provider');
    const ip = applyEdits(BUILTINS.governance!, { '/permissions/requests/6': 'network:10.0.0.1' });
    expect(codes(validateGlyph(ip))).toContain('scope_network_not_domain');
  });

  it('an unset (null) Rune value always fits, and a cosmetic Rune skips the vote only when the Henge exempts cosmetic Runes', () => {
    expect(planRuneChanges(BUILTINS.treasury!, { 'payout.per_accepted_task': null }).proposal).toEqual({ 'payout.per_accepted_task': null });
    const g = applyEdits(BUILTINS.governance!, { '/runes/0/cosmetic': true });
    expect(Object.keys(planRuneChanges(g, { 'voting.method': 'majority' }).proposal)).toEqual(['voting.method']);
    expect(Object.keys(planRuneChanges(g, { 'voting.method': 'majority' }, { cosmeticExempt: true }).direct)).toEqual(['voting.method']);
  });

  it.each([
    ['1.2.3', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['1.0.0', '~1.0.0', true], ['1.1.0', '~1.0.0', false],
    ['0.2.5', '^0.2.0', true], ['0.3.0', '^0.2.0', false], ['1.0.0', '1.0.0', true], ['1.0.1', '1.0.0', false], ['1.0.0-rc.1', '^1.0.0', false],
  ])('%s satisfies %s: %s', (v, r, ok) => {
    expect(satisfiesRange(v, r)).toBe(ok);
  });
});

/* ----------------------------------------------------------------------------------------------- */

describe('toManifestV1 (6.3)', () => {
  // Context values for this test only. Category and weight have no .henge v1 field.
  const ctx: ManifestContext = {
    baseUrl: 'https://raw.githubusercontent.com/example-org/resolved-forecasts/main/resolved-forecasts.henge/',
    category: 'science',
    categoryWeight: 1,
    harnessHash: `sha256-${'a'.repeat(64)}`,
  };

  it('the example converts to a ManifestV1 that passes the schema; the existing invariants catch its self-hosted coordinator with no url or key', () => {
    const r = toManifestV1(EXAMPLE, ctx);
    expect(codes(r).sort()).toEqual(['self_hosted_requires_key', 'self_hosted_requires_url']);
  });

  it('with a hosted coordinator the converted example passes manifestV1Schema and every existing invariant', () => {
    const h = applyEdits(EXAMPLE, { '/runtime/coordinator/mode': 'hosted' });
    const r = toManifestV1(h, ctx);
    expect(codes(r)).toEqual([]);
    if (!r.ok) return;
    expect(r.manifest).toMatchObject({
      id: 'example-org--resolved-forecasts',
      publisher: 'example-org',
      harness: { name: 'forecast-harness', version: '0.1.0', runtime: 'container' },
      models: { policy: 'diverse', api_allowed: true, diversity: { min_families: 3, min_accounts: 3 } },
      verification: ['known-answers', 'jury'],
      permissions: { network: ['en.wikipedia.org', 'web.archive.org'], scratch_disk_gb: 10, gpu_compute: false, api_spend_daily_usd: null },
      credits: { funded: false, per_accepted_task: null, pool_id: null },
      qualification: { tasks: 10, pass: 8 },
      task: { input_schema: `${ctx.baseUrl}benchmarks/schemas/question.schema.json` },
      results_url: `${ctx.baseUrl}benchmarks/leaderboard.json`,
      min_client_version: '0.2.0',
      'x-henge': { id: 'example-org/resolved-forecasts', version: '0.1.0' },
    });
  });

  it('runs the existing invariants on converted output: a model provider in the network is refused', () => {
    const h = applyEdits(EXAMPLE, { '/runtime/coordinator/mode': 'hosted', '/task/permissions/network': ['openrouter.ai'] });
    expect(codes(toManifestV1(h, ctx))).toContain('network_lists_model_provider');
  });

  it('fields with no .henge source are not guessed: without a category the schema reports it missing', () => {
    const h = applyEdits(EXAMPLE, { '/runtime/coordinator/mode': 'hosted' });
    const r = validateManifest(hengeToManifestCandidate(h, { ...ctx, category: undefined }));
    expect(r.ok ? [] : r.issues.map((i) => i.path)).toEqual(['/category']);
  });
});

describe('canonical bundle digest (6.6)', () => {
  it('is sha256 over sorted path NUL sha256(file) newline lines, with henge.yaml as canonical JSON', async () => {
    const files = new Map([['strategies/a.md', bytes('A')], ['henge.yaml', bytes(EXAMPLE_SRC)]]);
    const { signatures: _s, ...rest } = EXAMPLE;
    const { bundle_digest: _d, commit: _c, ...src } = rest.source;
    const manifestHex = await sha256Hex(canonicalJson({ ...rest, source: src }));
    const expected = `sha256-${await sha256Hex(`henge.yaml\0${manifestHex}\nstrategies/a.md\0${await sha256Hex('A')}\n`)}`;
    expect(await hengeBundleDigest(files)).toBe(expected);
  });

  it('ignores YAML formatting, key order, signatures and the release-set source fields', async () => {
    const base = await hengeFileDigest(EXAMPLE_SRC);
    expect(await hengeFileDigest(JSON.stringify(EXAMPLE))).toBe(base);
    const signed = { ...clone(EXAMPLE), signatures: [{ key_id: 'k', algorithm: 'ed25519', signature: 'AA==' }] };
    signed.source.bundle_digest = base;
    signed.source.commit = 'a'.repeat(40);
    expect(await hengeFileDigest(stringify(signed))).toBe(base);
    expect(await hengeFileDigest(stringify({ ...clone(EXAMPLE), version: '0.1.1' }))).not.toBe(base);
  });

  it('changes when any file changes or moves', async () => {
    const a = await hengeBundleDigest(new Map([['henge.yaml', bytes(EXAMPLE_SRC)], ['x.md', bytes('1')]]));
    expect(await hengeBundleDigest(new Map([['henge.yaml', bytes(EXAMPLE_SRC)], ['x.md', bytes('2')]]))).not.toBe(a);
    expect(await hengeBundleDigest(new Map([['henge.yaml', bytes(EXAMPLE_SRC)], ['y.md', bytes('1')]]))).not.toBe(a);
  });
});

describe('landing markdown sanitizer (6.5 step 6)', () => {
  const opts = { path: 'landing/README.md', bundleFiles: ['landing/hero.svg', 'landing/README.md'] };
  const clean = (md: string) => sanitizeLandingMarkdown(md, opts).markdown;

  it.each([
    ['<script>alert(1)</script>Hi', 'Hi'],
    ['<SCRIPT src=x></SCRIPT>ok', 'ok'],
    ['<iframe src="https://evil.example"></iframe>x', 'x'],
    ['<form action="https://evil.example"><input name=a></form>y', 'y'],
    ['<b onclick="alert(1)">bold</b>', '<b>bold</b>'],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="jav&#x61;script:alert(1)">x</a>', '<a>x</a>'],
    ['[x](javascript:alert(1))', 'x'],
    ['![hero](hero.svg)', '![hero](hero.svg)'],
    ['![remote](https://cdn.example/track.png)', 'remote'],
    ['![missing](missing.png)', 'missing'],
    ['![escape](../../etc/passwd)', 'escape'],
    ['<img src="https://evil.example/x.png" onerror="alert(1)">', ''],
    ['<img src="hero.svg" onerror="alert(1)">', '<img src="hero.svg">'],
    ['<img src=x onerror=alert(1)//', '&lt;img src=x onerror=alert(1)//'],
    ['<div style="x">a</div>', '<div>a</div>'],
    ['<!-- hidden -->text', 'text'],
    ['[ok](https://example.org) and <https://example.org>', '[ok](https://example.org) and <https://example.org>'],
  ])('%s', (input, output) => {
    expect(clean(input)).toBe(output);
  });

  it('leaves code blocks and inline code as written', () => {
    const md = '```html\n<script>x</script>\n```\nUse `<b onclick=x>` here.';
    expect(clean(md)).toBe(md);
  });

  it('drops reference images that point outside the bundle and unsafe definitions', () => {
    const md = '![a][r]\n\n[r]: https://cdn.example/a.png\n[bad]: javascript:alert(1)';
    expect(clean(md)).toBe('a\n\n[r]: https://cdn.example/a.png');
  });
});

/* ----------------------------------------------------------------------------------------------- */
/* Resolver (6.5): fake network only                                                                */
/* ----------------------------------------------------------------------------------------------- */

type Route = () => Response;
function fakeNet(routes: Record<string, Route>, dns: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const deps: ResolveDeps = {
    fetch: async (url) => {
      calls.push(url);
      const r = routes[url];
      return r ? r() : new Response('not found', { status: 404 });
    },
    lookup: async (host) => (dns[host] ?? ['140.82.112.3']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const),
  };
  return { deps, calls };
}
const ok = (body: string | Uint8Array, headers: Record<string, string> = {}) => () => new Response(body as BodyInit, { status: 200, headers });
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
const jsonOk = (v: unknown) => ok(JSON.stringify(v), { 'content-type': 'application/json' });

function makeZip(files: Record<string, string>, opts: { symlink?: string } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = deflateRawSync(data);
    const nameB = Buffer.from(name);
    const mode = name === opts.symlink ? 0o120777 : 0o100644;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameB.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(off, 42);
    locals.push(local, nameB, comp);
    centrals.push(central, nameB);
    off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

function makeTarGz(files: Record<string, string>, opts: { symlink?: string } = {}): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write(name === opts.symlink ? '2' : '0', 156);
    h.write('ustar\x0000', 257);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

const BUNDLE_FILES = { 'henge.yaml': EXAMPLE_SRC, 'strategies/base-rate-first.md': '# Base rate first (example)\n', 'landing/README.md': '# Resolved Forecasts (example)\n' };

describe('henge URL resolution (6.5)', () => {
  it('rewrites GitHub blob URLs to raw and classifies the URL forms', () => {
    expect(githubBlobToRaw('https://github.com/o/r/blob/main/x/a.henge.yaml')).toBe('https://raw.githubusercontent.com/o/r/main/x/a.henge.yaml');
    expect(classifyHengeUrl('https://github.com/o/r/tree/main/x/a.henge')).toEqual({ kind: 'github_tree', owner: 'o', repo: 'r', ref: 'main', path: 'x/a.henge' });
    expect(classifyHengeUrl('https://example.org/a.henge.zip')).toMatchObject({ kind: 'archive', format: 'zip' });
    expect(classifyHengeUrl('https://github.com/o/r/blob/main/a.henge.tar.gz')).toMatchObject({ kind: 'archive', format: 'tar.gz', url: 'https://raw.githubusercontent.com/o/r/main/a.henge.tar.gz' });
    expect(() => classifyHengeUrl('https://github.com/o/r/tree/main/docs')).toThrow(/henge/);
  });

  it('GitHub blob URL: fetched from raw.githubusercontent.com and pinned by etag', async () => {
    const raw = 'https://raw.githubusercontent.com/example-org/resolved-forecasts/main/resolved-forecasts.henge.yaml';
    const { deps, calls } = fakeNet({ [raw]: ok(EXAMPLE_SRC, { etag: '"e1"' }) });
    const r = await resolveHenge('https://github.com/example-org/resolved-forecasts/blob/main/resolved-forecasts.henge.yaml', deps, { glyphManifests: MANIFESTS });
    expect(codes(r)).toEqual([]);
    expect(calls).toEqual([raw]);
    if (r.ok) expect(r.pin).toEqual({ url: 'https://github.com/example-org/resolved-forecasts/blob/main/resolved-forecasts.henge.yaml', commit: null, etag: '"e1"', bundle_digest: await hengeFileDigest(EXAMPLE_SRC), version: '0.1.0' });
  });

  it('raw URL: a single file at any https URL', async () => {
    const url = 'https://henges.example.org/resolved-forecasts.henge';
    const { deps } = fakeNet({ [url]: ok(EXAMPLE_SRC) });
    const r = await resolveHenge(url, deps);
    expect(codes(r)).toEqual([]);
    if (r.ok) expect([...r.files.keys()]).toEqual(['henge.yaml']);
  });

  it('GitHub tree URL: pins the commit, fetches henge.yaml first, then the folder through the contents API', async () => {
    const sha = 'c'.repeat(40);
    const api = 'https://api.github.com/repos/example-org/resolved-forecasts';
    const raw = `https://raw.githubusercontent.com/example-org/resolved-forecasts/${sha}/resolved-forecasts.henge`;
    const dir = 'resolved-forecasts.henge';
    const { deps, calls } = fakeNet({
      [`${api}/commits/main`]: jsonOk({ sha }),
      [`${raw}/henge.yaml`]: ok(EXAMPLE_SRC),
      [`${api}/contents/${dir}?ref=${sha}`]: jsonOk([
        { type: 'file', path: `${dir}/henge.yaml`, size: EXAMPLE_SRC.length },
        { type: 'dir', path: `${dir}/strategies`, size: 0 },
      ]),
      [`${api}/contents/${dir}/strategies?ref=${sha}`]: jsonOk([{ type: 'file', path: `${dir}/strategies/base-rate-first.md`, size: 10 }]),
      [`${raw}/strategies/base-rate-first.md`]: ok('# Example\n'),
    });
    const r = await resolveHenge(`https://github.com/example-org/resolved-forecasts/tree/main/${dir}`, deps, { glyphManifests: MANIFESTS });
    expect(codes(r)).toEqual([]);
    expect(calls[1]).toBe(`${raw}/henge.yaml`);
    if (r.ok) {
      expect(r.pin.commit).toBe(sha);
      expect([...r.files.keys()].sort()).toEqual(['henge.yaml', 'strategies/base-rate-first.md']);
    }
  });

  it('GitHub tree URL: a symlink in the folder is refused', async () => {
    const sha = 'd'.repeat(40);
    const api = 'https://api.github.com/repos/o/r';
    const { deps } = fakeNet({
      [`https://raw.githubusercontent.com/o/r/${sha}/a.henge/henge.yaml`]: ok(EXAMPLE_SRC),
      [`${api}/contents/a.henge?ref=${sha}`]: jsonOk([{ type: 'symlink', path: 'a.henge/link', size: 4 }]),
    });
    expect(codes(await resolveHenge(`https://github.com/o/r/tree/${sha}/a.henge`, deps))).toEqual(['archive_symlink']);
  });

  it('zip: extracted in memory, top folder stripped, pinned by etag', async () => {
    const url = 'https://example.org/resolved-forecasts.henge.zip';
    const zip = makeZip(Object.fromEntries(Object.entries(BUNDLE_FILES).map(([k, v]) => [`resolved-forecasts.henge/${k}`, v])));
    const { deps } = fakeNet({ [url]: ok(zip, { etag: '"z"' }) });
    const r = await resolveHenge(url, deps, { glyphManifests: MANIFESTS });
    expect(codes(r)).toEqual([]);
    if (r.ok) {
      expect([...r.files.keys()].sort()).toEqual(Object.keys(BUNDLE_FILES).sort());
      expect(r.pin).toMatchObject({ etag: '"z"', commit: null, version: '0.1.0' });
      expect(r.pin.bundle_digest).toBe(await hengeBundleDigest(new Map(Object.entries(BUNDLE_FILES).map(([k, v]) => [k, bytes(v)]))));
    }
  });

  it('tar.gz: extracted in memory', async () => {
    const url = 'https://example.org/resolved-forecasts.henge.tar.gz';
    const { deps } = fakeNet({ [url]: ok(makeTarGz(BUNDLE_FILES)) });
    expect(codes(await resolveHenge(url, deps))).toEqual([]);
  });

  it.each([
    ['zip', 'https://example.org/a.henge.zip', makeZip({ ...BUNDLE_FILES, 'landing/link': '/etc/passwd' }, { symlink: 'landing/link' })],
    ['tar.gz', 'https://example.org/a.henge.tar.gz', makeTarGz({ ...BUNDLE_FILES, 'landing/link': '' }, { symlink: 'landing/link' })],
  ])('%s with a symlink is refused', async (_k, url, data) => {
    const { deps } = fakeNet({ [url]: ok(data) });
    expect(codes(await resolveHenge(url, deps))).toEqual(['archive_symlink']);
  });

  it('an archive with an executable outside benchmarks/scorer/ is invalid', async () => {
    const url = 'https://example.org/a.henge.zip';
    const { deps } = fakeNet({ [url]: ok(makeZip({ ...BUNDLE_FILES, 'landing/run.sh': 'echo hi\n' })) });
    expect(codes(await resolveHenge(url, deps))).toContain('bundle_executable_file');
  });

  it('http is rejected before any request', async () => {
    const { deps, calls } = fakeNet({});
    expect(codes(await resolveHenge('http://example.org/a.henge', deps))).toEqual(['not_https']);
    expect(calls).toEqual([]);
  });

  it.each([
    ['DNS answer in 10/8', { 'evil.example': ['10.1.2.3'] }],
    ['DNS answer loopback', { 'evil.example': ['127.0.0.1'] }],
    ['one of several answers is private', { 'evil.example': ['140.82.112.3', '169.254.169.254'] }],
    ['IPv6 loopback', { 'evil.example': ['::1'] }],
    ['IPv4-mapped IPv6', { 'evil.example': ['::ffff:192.168.0.1'] }],
  ])('private IP after DNS resolution is rejected: %s', async (_l, dns) => {
    const { deps, calls } = fakeNet({ 'https://evil.example/a.henge': ok(EXAMPLE_SRC) }, dns);
    expect(codes(await resolveHenge('https://evil.example/a.henge', deps))).toEqual(['private_address']);
    expect(calls).toEqual([]);
  });

  it('a redirect to a private address is rejected', async () => {
    const { deps, calls } = fakeNet({ 'https://example.org/a.henge': redirect('https://internal.example/a.henge') }, { 'internal.example': ['192.168.1.10'] });
    expect(codes(await resolveHenge('https://example.org/a.henge', deps))).toEqual(['private_address']);
    expect(calls).toEqual(['https://example.org/a.henge']);
  });

  it('a redirect to an IP literal or to http is rejected', async () => {
    const a = fakeNet({ 'https://example.org/a.henge': redirect('https://127.0.0.1/a.henge') });
    expect(codes(await resolveHenge('https://example.org/a.henge', a.deps))).toEqual(['private_address']);
    const b = fakeNet({ 'https://example.org/a.henge': redirect('http://example.org/a.henge') });
    expect(codes(await resolveHenge('https://example.org/a.henge', b.deps))).toEqual(['not_https']);
  });

  it('a redirect loop is detected', async () => {
    const { deps } = fakeNet({ 'https://example.org/a': redirect('https://example.org/b'), 'https://example.org/b': redirect('https://example.org/a') });
    expect(codes(await resolveHenge('https://example.org/a', deps))).toEqual(['redirect_loop']);
  });

  it('five redirects are followed, the sixth is refused', async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 6; i++) routes[`https://example.org/${i}`] = redirect(`https://example.org/${i + 1}`);
    routes['https://example.org/5'] = ok(EXAMPLE_SRC);
    expect(codes(await resolveHenge('https://example.org/0', fakeNet(routes).deps))).toEqual([]);
    routes['https://example.org/5'] = redirect('https://example.org/6');
    routes['https://example.org/6'] = ok(EXAMPLE_SRC);
    expect(codes(await resolveHenge('https://example.org/0', fakeNet(routes).deps))).toEqual(['too_many_redirects']);
  });

  it('oversize cap: a manifest over 256 KB is refused, by header or by streamed length', async () => {
    const big = `${EXAMPLE_SRC}\n# ${'x'.repeat(HENGE_MANIFEST_MAX_BYTES)}\n`;
    const { deps } = fakeNet({ 'https://example.org/a.henge': ok(big) });
    expect(codes(await resolveHenge('https://example.org/a.henge', deps))).toEqual(['too_large']);
    const lying = fakeNet({ 'https://example.org/b.henge': () => new Response(big, { status: 200, headers: { 'content-length': '10' } }) });
    expect(codes(await resolveHenge('https://example.org/b.henge', lying.deps))).toEqual(['too_large']);
  });

  it('oversize cap: a landing asset over 2 MB is refused', async () => {
    const url = 'https://example.org/a.henge.zip';
    const { deps } = fakeNet({ [url]: ok(makeZip({ ...BUNDLE_FILES, 'landing/hero.svg': 'x'.repeat(2 * 1024 * 1024 + 1) })) });
    expect(codes(await resolveHenge(url, deps))).toEqual(['landing_asset_too_large']);
  });

  it('oversize cap: a zip that declares more than 25 MB is refused before inflating', async () => {
    const zip = makeZip({ 'henge.yaml': EXAMPLE_SRC });
    // Patch the declared uncompressed size in the central directory to 26 MB.
    const view = Buffer.from(zip);
    const cd = view.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    view.writeUInt32LE(26 * 1024 * 1024, cd + 24);
    await expect(extractZip(new Uint8Array(view), 25 * 1024 * 1024)).rejects.toMatchObject({ code: 'bundle_too_large' });
  });

  it('a declared bundle digest must match what was fetched', async () => {
    const h = applyEdits(EXAMPLE, { '/source/bundle_digest': `sha256-${'0'.repeat(64)}` });
    const { deps } = fakeNet({ 'https://example.org/a.henge': ok(stringify(h)) });
    expect(codes(await resolveHenge('https://example.org/a.henge', deps))).toEqual(['bundle_digest_mismatch']);
  });

  it.each([
    ['140.82.112.3', true], ['8.8.8.8', true], ['10.0.0.1', false], ['172.16.5.4', false], ['172.32.0.1', true], ['192.168.0.1', false],
    ['127.0.0.1', false], ['169.254.169.254', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false],
    ['2606:4700::1111', true], ['::1', false], ['::', false], ['fe80::1', false], ['fd00::1', false], ['ff02::1', false], ['2001:db8::1', false],
    ['::ffff:10.0.0.1', false], ['::ffff:8.8.8.8', true], ['64:ff9b::a00:1', false], ['not-an-ip', false],
  ])('isPublicAddress(%s) is %s', (ip, pub) => {
    expect(isPublicAddress(ip)).toBe(pub);
  });
});
