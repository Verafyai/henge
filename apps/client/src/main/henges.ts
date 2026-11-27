/**
 * Henges on this computer (spin-out spec v2, 6.5, 7.5, 7.6, 9.2). Resolves pasted `.henge` links with
 * the schema resolver, keeps the files you joined or created under userData/henges, and checks every
 * Glyph and Rune change with the schema rules before anything is written. Nothing here runs tasks.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkGlyphGrant,
  checkJoinReadiness,
  hengeBundleDigest,
  parseGlyph,
  parseGlyphUse,
  planRuneChanges,
  resolveHenge,
  validateHenge,
  validateHengeBundle,
  HENGE_MANIFEST_MAX_BYTES,
  type GlyphManifestV1,
  type HengeV1,
  type ResolveDeps,
} from '@swarm-explorer/schema';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  CreateInput,
  GlyphAddInput,
  GlyphAddPlan,
  GlyphAddResult,
  HengeResolveView,
  IssueView,
  JoinInput,
  LocalHenge,
  RuneApplyResult,
  RuneInput,
  RunePlanView,
} from '../shared/henge';
import exampleSource from '../../../../packages/schema/fixtures/henge/valid/example.henge.yaml?raw';

const glyphSources = import.meta.glob('../../../../packages/schema/fixtures/glyphs/verafy/*.glyph.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

let builtins: GlyphManifestV1[] | null = null;
/** The built-in Glyphs (7.1, publisher verafy), validated once. They are example manifests until the directory exists. */
export function builtinGlyphs(): GlyphManifestV1[] {
  if (builtins) return builtins;
  builtins = Object.keys(glyphSources)
    .sort()
    .map((k) => {
      const r = parseGlyph(glyphSources[k]!);
      if (!r.ok) throw new Error(`Built-in Glyph ${k} is invalid: ${r.issues.map((i) => i.message).join('; ')}`);
      return r.glyph;
    });
  return builtins;
}

export const keyOf = (id: string) => id.replace('/', '--');
const fail = (code: string, message: string): HengeResolveView => ({ ok: false, code, message, issues: [{ code, path: '', message }] });

/** Accepts a `.henge` URL, a `henge://add?url=` link or an invite link and returns the URL to fetch. */
export function hengeLinkTarget(input: string): { url: string } | { error: HengeResolveView } {
  const raw = input.trim();
  if (!raw) return { error: fail('empty', 'Paste a .henge link.') };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: fail('bad_url', 'That is not a link. Paste a .henge URL, an invite link or a henge://add link.') };
  }
  if (u.protocol === 'henge:') {
    const inner = u.hostname === 'add' ? u.searchParams.get('url') : null;
    if (!inner || [...u.searchParams.keys()].some((k) => k !== 'url')) return { error: fail('bad_link', 'Only henge://add?url=<.henge link> links can add a Henge.') };
    return hengeLinkTarget(inner);
  }
  if (u.protocol === 'https:' && u.hostname === 'henge.verafy.ai' && /^\/i\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))
    return { error: fail('invite_unavailable', 'Invite links need the Henge community service, which this build does not connect to yet. Ask the person who invited you for the .henge link.') };
  return { url: u.href };
}

export type HengeLibraryDeps = {
  dir: string;
  /** Unpackaged test hook: also accept file:// URLs. Never set in packaged builds. */
  allowFileUrls: boolean;
  resolveDeps?: ResolveDeps;
  now?: () => number;
};

type Record_ = Omit<LocalHenge, 'henge'>;

const defaultResolveDeps: ResolveDeps = {
  fetch: (url, init) => fetch(url, init),
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })),
};

export class HengeLibrary {
  private resolved = new Map<string, Extract<HengeResolveView, { ok: true }> & { text: string }>();
  constructor(private readonly deps: HengeLibraryDeps) {
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  }

  private get indexPath() {
    return path.join(this.deps.dir, 'index.json');
  }

  private records(): Record_[] {
    try {
      const v = JSON.parse(readFileSync(this.indexPath, 'utf8')) as unknown;
      return Array.isArray(v) ? (v as Record_[]) : [];
    } catch {
      return [];
    }
  }

  private writeAtomic(file: string, text: string) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  }

  private saveRecords(rs: Record_[]) {
    this.writeAtomic(this.indexPath, `${JSON.stringify(rs, null, 2)}\n`);
  }

  private load(r: Record_): LocalHenge | null {
    try {
      const v = validateHenge(parseYaml(readFileSync(r.file, 'utf8')), { glyphManifests: builtinGlyphs() });
      return v.ok ? { ...r, henge: v.henge } : null;
    } catch {
      return null;
    }
  }

  list(): LocalHenge[] {
    return this.records()
      .map((r) => this.load(r))
      .filter((h): h is LocalHenge => h !== null);
  }

  get(key: string): LocalHenge | null {
    const r = this.records().find((x) => x.key === key);
    return r ? this.load(r) : null;
  }

  /** The `.henge` file text as stored here. */
  source(key: string): string | null {
    const r = this.records().find((x) => x.key === key);
    return r && existsSync(r.file) ? readFileSync(r.file, 'utf8') : null;
  }

  async resolve(input: string): Promise<HengeResolveView> {
    const t = hengeLinkTarget(input);
    if ('error' in t) return t.error;
    const url = t.url;
    let text: string;
    let view: Extract<HengeResolveView, { ok: true }>;
    if (url.startsWith('file:')) {
      if (!this.deps.allowFileUrls) return fail('not_https', 'Only https links can add a Henge.');
      try {
        const data = readFileSync(fileURLToPath(url));
        if (data.byteLength > HENGE_MANIFEST_MAX_BYTES) return fail('too_large', 'The .henge file is too large.');
        const files = new Map([['henge.yaml', new Uint8Array(data)]]);
        const v = validateHengeBundle(files, { glyphManifests: builtinGlyphs() });
        if (!v.ok) return { ok: false, code: 'invalid', message: 'This .henge file did not pass the checks.', issues: v.issues };
        text = data.toString('utf8');
        const digest = await hengeBundleDigest(files);
        view = { ok: true, url, henge: v.henge, unchecked: v.unchecked, pin: { url, commit: null, etag: null, bundle_digest: digest, version: v.henge.version }, existingKey: null };
      } catch {
        return fail('not_found', 'That file could not be read.');
      }
    } else {
      const r = await resolveHenge(url, this.deps.resolveDeps ?? defaultResolveDeps, { glyphManifests: builtinGlyphs() });
      if (!r.ok) return { ok: false, code: r.issues[0]?.code ?? 'invalid', message: r.issues[0]?.message ?? 'This .henge link did not pass the checks.', issues: r.issues };
      text = new TextDecoder().decode(r.files.get('henge.yaml'));
      view = { ok: true, url, henge: r.henge, unchecked: r.unchecked, pin: r.pin, existingKey: null };
    }
    const key = keyOf(view.henge.id);
    view.existingKey = this.records().some((x) => x.key === key) ? key : null;
    this.resolved.set(url, { ...view, text });
    if (this.resolved.size > 10) this.resolved.delete(this.resolved.keys().next().value!);
    return view;
  }

  /** Joins the exact file the invite card showed. Required caps, roles and ranges are checked here again. */
  join(input: JoinInput): { ok: true; henge: LocalHenge } | { ok: false; issues: IssueView[] } {
    const target = hengeLinkTarget(input.url);
    const r = 'url' in target ? this.resolved.get(target.url) : undefined;
    if (!r) return { ok: false, issues: [{ code: 'not_resolved', path: '', message: 'Open the link again before joining.' }] };
    if (r.pin.bundle_digest !== input.bundleDigest) return { ok: false, issues: [{ code: 'changed', path: '', message: 'The .henge file changed since you reviewed it. Open the link again.' }] };
    const h = r.henge;
    const p = input.participation;
    const issues: IssueView[] = checkJoinReadiness(h, { daily_cap: p.dailyCapCents === null ? null : p.dailyCapCents / 100 });
    const attest = h.admission.requirements.attest ?? [];
    if (attest.length !== input.attested.length || attest.some((a, i) => input.attested[i] !== a)) issues.push({ code: 'attest_missing', path: '/admission/requirements/attest', message: 'Accept every rule of this Henge first.' });
    if (!h.participation.roles_offered.some((x) => x.id === p.role)) issues.push({ code: 'role_not_offered', path: '/participation/roles_offered', message: `${p.role} is not a role this Henge offers.` });
    const cores = h.participation.compute.cpu_cores;
    if ((cores.min !== undefined && p.cpuCores < cores.min) || (cores.max !== undefined && p.cpuCores > cores.max))
      issues.push({ code: 'cores_out_of_range', path: '/participation/compute/cpu_cores', message: 'CPU cores are outside the range this Henge allows.' });
    if (issues.length) return { ok: false, issues };
    const key = keyOf(h.id);
    const file = path.join(this.deps.dir, `${key}.henge.yaml`);
    this.writeAtomic(file, r.text);
    const rec: Record_ = {
      key,
      status: h.admission.mode === 'open' ? 'joined' : 'awaiting_admission',
      sourceUrl: r.url,
      pin: r.pin,
      participation: p,
      file,
      addedAt: (this.deps.now ?? Date.now)(),
    };
    this.saveRecords([...this.records().filter((x) => x.key !== key), rec]);
    return { ok: true, henge: { ...rec, henge: h } };
  }

  leave(key: string): boolean {
    const rs = this.records();
    const r = rs.find((x) => x.key === key);
    if (!r) return false;
    rmSync(r.file, { force: true });
    this.saveRecords(rs.filter((x) => x.key !== key));
    return true;
  }

  /** Builds a new `.henge` file from a template and stores it on this computer. */
  create(input: CreateInput): { ok: true; henge: LocalHenge } | { ok: false; issues: IssueView[] } {
    const h = buildFromTemplate(input);
    const v = validateHenge(h, { glyphManifests: builtinGlyphs() });
    if (!v.ok) return { ok: false, issues: v.issues };
    const key = keyOf(v.henge.id);
    if (this.records().some((x) => x.key === key)) return { ok: false, issues: [{ code: 'exists', path: '/id', message: 'A Henge with this name is already on this computer. Pick another name.' }] };
    const file = path.join(this.deps.dir, `${key}.henge.yaml`);
    this.writeAtomic(file, stringifyYaml(v.henge));
    const rec: Record_ = { key, status: 'owner', sourceUrl: null, pin: null, participation: null, file, addedAt: (this.deps.now ?? Date.now)() };
    this.saveRecords([...this.records(), rec]);
    return { ok: true, henge: { ...rec, henge: v.henge } };
  }

  private actorRole(h: LocalHenge): string {
    return h.status === 'owner' ? 'owner' : 'member';
  }

  planGlyphAdd(input: GlyphAddInput): GlyphAddPlan {
    const h = this.get(input.key);
    const glyph = builtinGlyphs().find((g) => g.id === input.glyphId);
    if (!h || !glyph) return { mode: 'none', reason: 'That Henge or Glyph is not available.', issues: [] };
    const issues: IssueView[] = [];
    if ((h.henge.glyphs ?? []).some((e) => parseGlyphUse(e.use)?.id === glyph.id)) issues.push({ code: 'glyph_already_added', path: '/glyphs', message: `${glyph.name} is already added to this Henge.` });
    issues.push(...checkGlyphGrant({ glyph, granted: input.granted, memberCount: h.status === 'owner' ? 1 : 2, votePassed: false }).filter((i) => i.code !== 'scope_requires_vote'));
    const role = this.actorRole(h);
    const canAdd = (h.henge.governance.roles[role]?.can ?? []).includes('add_glyph');
    const needsVote = h.henge.governance.rule_updates.vote_required_for.includes('glyphs.add');
    const gatedVote = checkGlyphGrant({ glyph, granted: input.granted, memberCount: h.status === 'owner' ? 1 : 2, votePassed: false }).some((i) => i.code === 'scope_requires_vote');
    if (needsVote || gatedVote) return { mode: 'propose', reason: 'Adding this Glyph needs a member vote under your current rules.', issues };
    if (canAdd && h.status === 'owner') return { mode: 'add', reason: 'You can add this Glyph directly.', issues };
    return { mode: 'none', reason: 'Your role cannot add Glyphs here. Ask a maintainer.', issues };
  }

  addGlyph(input: GlyphAddInput): GlyphAddResult {
    const plan = this.planGlyphAdd(input);
    if (plan.issues.length) return { ok: false, issues: plan.issues };
    if (plan.mode === 'none') return { ok: false, issues: [{ code: 'not_allowed', path: '', message: plan.reason }] };
    const h = this.get(input.key)!;
    if (plan.mode === 'propose') return { ok: true, mode: 'proposed', henge: h };
    const glyph = builtinGlyphs().find((g) => g.id === input.glyphId)!;
    const next: HengeV1 = structuredClone(h.henge);
    next.glyphs = [
      ...(next.glyphs ?? []),
      { use: `${glyph.id}@^${glyph.version}`, source: glyph.source?.repo ?? glyph.publisher.url, digest: null, added_by: next.governance.holders.owner[0] ?? 'owner', granted: [...input.granted] },
    ];
    ensureGlyphChannels(next, glyph, input.granted);
    return this.rewrite(h, next);
  }

  private rewrite(h: LocalHenge, next: HengeV1): { ok: true; henge: LocalHenge; mode: 'added' } | { ok: false; issues: IssueView[] } {
    next.version = bumpPatch(next.version);
    const v = validateHenge(next, { glyphManifests: builtinGlyphs() });
    if (!v.ok) return { ok: false, issues: v.issues };
    this.writeAtomic(h.file, stringifyYaml(v.henge));
    return { ok: true, mode: 'added', henge: { ...h, henge: v.henge } };
  }

  private runeContext(h: HengeV1) {
    return {
      roles: Object.keys(h.governance.roles),
      channels: (h.community?.categories ?? []).flatMap((c) => c.channels.map((ch) => ch.id)),
      cosmeticExempt: (h.governance.rule_updates.no_vote_needed_for ?? []).includes('glyphs.runes.cosmetic'),
    };
  }

  planRunes(input: RuneInput): RunePlanView | null {
    const h = this.get(input.key);
    const glyph = builtinGlyphs().find((g) => g.id === input.glyphId);
    if (!h || !glyph) return null;
    return planRuneChanges(glyph, input.changes, this.runeContext(h.henge));
  }

  /** Applies the Rune changes the actor may make now; vote-gated ones are returned for a proposal and not applied. */
  applyRunes(input: RuneInput): RuneApplyResult {
    const h = this.get(input.key);
    const glyph = builtinGlyphs().find((g) => g.id === input.glyphId);
    if (!h || !glyph) return { ok: false, issues: [{ code: 'not_found', path: '', message: 'That Henge or Glyph is not available.' }] };
    const plan = planRuneChanges(glyph, input.changes, this.runeContext(h.henge));
    if (plan.issues.length) return { ok: false, issues: plan.issues };
    const role = this.actorRole(h);
    const refused = Object.entries(plan.approvers).filter(([, who]) => (who === 'owner' && role !== 'owner') || (who === 'maintainer' && role !== 'owner' && role !== 'maintainer'));
    if (refused.length) return { ok: false, issues: refused.map(([id, who]) => ({ code: 'rune_needs_role', path: `/runes/${id}`, message: `Only a ${who} can change ${glyph.runes?.find((r) => r.id === id)?.name ?? id}.` })) };
    const applied = Object.keys(plan.direct);
    if (!applied.length) return { ok: true, henge: h, applied, proposal: plan.proposal };
    const next: HengeV1 = structuredClone(h.henge);
    const entry = (next.glyphs ?? []).find((e) => parseGlyphUse(e.use)?.id === glyph.id);
    if (!entry) return { ok: false, issues: [{ code: 'glyph_not_added', path: '/glyphs', message: `${glyph.name} is not added to this Henge.` }] };
    entry.runes = { ...(entry.runes ?? {}), ...plan.direct };
    const r = this.rewrite(h, next);
    return r.ok ? { ok: true, henge: r.henge, applied, proposal: plan.proposal } : r;
  }
}

function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : v;
}

/** A Glyph's channels must exist (6.4); add any that are missing to their category. */
function ensureGlyphChannels(h: HengeV1, glyph: GlyphManifestV1, granted: readonly string[] = glyph.permissions.requests) {
  h.community ??= { enabled: true, categories: [] };
  h.community.categories ??= [];
  const all = new Set(h.community.categories.flatMap((c) => c.channels.map((x) => x.id)));
  const slug = glyph.id.split('/')[1]!;
  // Channels the Glyph creates, then channels a granted post scope names (as announcement channels under Info).
  const wanted = [
    ...(glyph.channels ?? []),
    ...granted.filter((s) => s.startsWith('post:channel:')).map((s) => ({ id: s.slice('post:channel:'.length), type: 'announcement' as const, category: 'info' })),
  ];
  for (const ch of wanted) {
    if (all.has(ch.id)) continue;
    const catId = ch.category ?? 'glyphs';
    let cat = h.community.categories.find((c) => c.id === catId);
    if (!cat) {
      cat = { id: catId, name: catId[0]!.toUpperCase() + catId.slice(1), channels: [] };
      h.community.categories.push(cat);
    }
    cat.channels.push({ id: ch.id, type: ch.type, glyph_posts: [slug] });
    all.add(ch.id);
  }
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'henge';

/**
 * The "Forecasting swarm" template is the example `.henge` file with your name, owner, channels and
 * Glyphs. Its URLs stay the example.org placeholders until the file is published somewhere.
 */
export function buildFromTemplate(input: CreateInput): HengeV1 {
  const base = parseYaml(exampleSource) as HengeV1;
  const h: HengeV1 = structuredClone(base);
  const slug = slugify(input.name);
  const owner = input.ownerHandle.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'owner';
  h.id = `${owner}/${slug}`;
  h.version = '0.1.0';
  h.name = input.name;
  h.landing = { ...h.landing, title: input.name, tagline: input.tagline || h.landing.tagline, 'x-henge-icon-text': input.icon };
  delete h.landing.hero_image;
  delete h.landing.icon;
  h.source = { ...h.source, commit: null, bundle_digest: null };
  h.governance.holders = { owner: [input.ownerHandle] };
  h.governance.rule_updates.vote_required_for = h.governance.rule_updates.vote_required_for.filter((x) => x !== 'glyphs.add');
  delete h.signatures;
  const chosen = builtinGlyphs().filter((g) => input.glyphs.includes(g.id));
  const slugs = new Set(chosen.map((g) => g.id.split('/')[1]!));
  h.glyphs = chosen.map((g) => ({ use: `${g.id}@^${g.version}`, source: g.source?.repo ?? g.publisher.url, digest: null, added_by: input.ownerHandle, granted: [...g.permissions.requests] }));
  h.governance.voting = { glyph: slugs.has('governance') ? 'governance' : (h.governance.voting.glyph ?? 'governance') };
  h.community = {
    ...h.community,
    enabled: true,
    categories: [{ id: 'community', name: 'Community', channels: [...new Set(input.channels)].map((id) => ({ id, type: 'text' as const })) }],
  };
  for (const g of chosen) ensureGlyphChannels(h, g);
  for (const cat of h.community.categories!) for (const ch of cat.channels) ch.glyph_posts = chosen.filter((g) => (g.channels ?? []).some((c) => c.id === ch.id)).map((g) => g.id.split('/')[1]!);
  for (const cat of h.community.categories!) for (const ch of cat.channels) if (!ch.glyph_posts?.length) delete ch.glyph_posts;
  return h;
}

export function hengeDir(userData: string) {
  return path.join(userData, 'henges');
}
