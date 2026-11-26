/**
 * `.henge` file v1 validation (spin-out spec v2, 6.2 and 6.4): the JSON Schema, then every
 * cross-field invariant. Rules that need more than one file (a bundle, the previous pinned
 * version, the member's own settings) have their own entry points below.
 */
import { checkRuneValue, parseGlyphUse, satisfiesRange, scopeIssues, validateGlyph } from './glyph-validate';
import { hengeValidators, schemaIssues } from './henge-ajv';
import type { GlyphManifestV1, HengeResult, HengeV1 } from './henge-v1';
import { MODEL_PROVIDER_DOMAINS } from './invariants';
import { canonicalJson } from './canonical';
import type { ManifestIssue } from './types';
import { parseManifestSource } from './yaml';

/** The major version of the `.henge` spec this code understands. */
export const HENGE_SPEC_MAJOR = 1;

/** Executables are allowed only here; the scorer runs in henge-bench CI, never on member machines (6.4). */
export const SCORER_DIR = 'benchmarks/scorer/';

/** Extensions treated as executable code anywhere outside `benchmarks/scorer/`. */
export const EXECUTABLE_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.pyc', '.pyw', '.sh', '.bash', '.zsh', '.fish', '.ksh', '.csh',
  '.rb', '.pl', '.php', '.lua', '.r', '.jar', '.class', '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin', '.com', '.bat', '.cmd',
  '.ps1', '.psm1', '.vbs', '.app', '.msi', '.deb', '.rpm', '.apk', '.elf', '.o', '.a',
] as const;

/** Text formats a strategy may use: prompts and procedures, never code (6.4). */
export const STRATEGY_EXTENSIONS = ['.md', '.txt'] as const;
/** Files allowed under `learnings.path`: the JSONL logs, their entry schema and notes. */
export const LEARNINGS_EXTENSIONS = ['.jsonl', '.json', '.md'] as const;

const DIGEST_RE = /^sha256-[a-f0-9]{64}$/;
const underDomain = (host: string, d: string) => host === d || host.endsWith(`.${d}`);
const hasExt = (p: string, exts: readonly string[]) => exts.some((e) => p.toLowerCase().endsWith(e));

export interface ValidateHengeOptions {
  /**
   * Glyph manifests the caller trusts for cross-checks (built-ins, the bundle's own `glyphs/`, or
   * manifests fetched from `glyphs[].source`). A `glyphs[]` entry with no matching manifest is
   * listed in `unchecked` instead of failing.
   */
  glyphManifests?: readonly GlyphManifestV1[];
}

/* ----------------------------------------------------------------------------------------------- */
/* Single-file rules                                                                                */
/* ----------------------------------------------------------------------------------------------- */

function relativeLuminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG 2 contrast ratio between two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The Henge page background the landing accent is drawn on (example.henge.yaml, `landing.accent`). */
export const LANDING_BACKGROUND = '#050506';
/** WCAG 2 level AA for normal text. */
export const WCAG_AA_NORMAL_TEXT = 4.5;

/** All channel ids declared in `community`, in order, with their JSON Pointer. */
function communityChannels(h: HengeV1) {
  const out: { id: string; path: string; glyph_posts: string[]; post: string[]; read: string[] }[] = [];
  (h.community?.categories ?? []).forEach((c, ci) =>
    c.channels.forEach((ch, i) => out.push({ id: ch.id, path: `/community/categories/${ci}/channels/${i}`, glyph_posts: ch.glyph_posts ?? [], post: ch.post ?? [], read: ch.read ?? [] })),
  );
  return out;
}

/** Cross-field rules for one `.henge` file (6.4 and 7.3). Assumes the schema passed. */
export function hengeInvariants(h: HengeV1, opts: ValidateHengeOptions = {}): { issues: ManifestIssue[]; unchecked: string[] } {
  const out: ManifestIssue[] = [];
  const unchecked: string[] = [];
  const add = (code: string, path: string, message: string) => out.push({ code, path, message });

  if (h.kind === 'template') add('kind_template_reserved', '/kind', 'The template kind is reserved. A v1 .henge file describes a swarm.');

  // Model calls go through the local proxy, never the harness network (6.4).
  h.task.permissions.network.forEach((host, i) => {
    if (MODEL_PROVIDER_DOMAINS.some((d) => underDomain(host, d)))
      add('network_lists_model_provider', `/task/permissions/network/${i}`, `${host} is a model provider; model calls go through the local proxy, not the task network.`);
  });

  h.benchmarks.forEach((b, i) => {
    const held = b.dataset.splits.heldout;
    if (held !== 'private' && !DIGEST_RE.test(held))
      add('heldout_not_private', `/benchmarks/${i}/dataset/splits/heldout`, 'The held-out split must be "private" or a digest-only reference (sha256-<hex>). Held-out items never ship in a public bundle.');
    if (!b.scorer.path.startsWith(SCORER_DIR))
      add('scorer_outside_scorer_dir', `/benchmarks/${i}/scorer/path`, `The scorer must live under ${SCORER_DIR}, the only place a bundle may hold code.`);
  });

  (h.strategies ?? []).forEach((s, i) => {
    if (!hasExt(s.path, STRATEGY_EXTENSIONS)) add('strategy_not_text', `/strategies/${i}/path`, 'A strategy is text only (Markdown or plain text): prompts and procedures, never code.');
  });

  if (h.landing.accent && contrastRatio(h.landing.accent, LANDING_BACKGROUND) < WCAG_AA_NORMAL_TEXT)
    add('landing_accent_contrast', '/landing/accent', `The accent must pass WCAG AA (${WCAG_AA_NORMAL_TEXT}:1) on ${LANDING_BACKGROUND}.`);

  for (const k of ['cpu_cores', 'ram_gb', 'scratch_disk_gb'] as const) {
    const r = h.participation.compute[k];
    const lo = r.min ?? -Infinity;
    const hi = r.max ?? Infinity;
    if (lo > hi || (r.default != null && (r.default < lo || r.default > hi)))
      add('compute_range_inconsistent', `/participation/compute/${k}`, `${k} needs min <= default <= max.`);
  }

  // Community structure (6.4): unique ids, known roles.
  const roles = Object.keys(h.governance.roles);
  const channels = communityChannels(h);
  const channelIds = new Set<string>();
  for (const c of channels) {
    if (channelIds.has(c.id)) add('community_channel_duplicate', `${c.path}/id`, `Channel id ${c.id} is used more than once.`);
    channelIds.add(c.id);
    for (const [field, list] of [['post', c.post], ['read', c.read]] as const)
      list.forEach((r, i) => {
        if (!roles.includes(r)) add('community_role_unknown', `${c.path}/${field}/${i}`, `${r} is not a role in governance.roles.`);
      });
  }
  const categoryIds = new Set<string>();
  (h.community?.categories ?? []).forEach((c, i) => {
    if (categoryIds.has(c.id)) add('community_category_duplicate', `/community/categories/${i}/id`, `Category id ${c.id} is used more than once.`);
    categoryIds.add(c.id);
  });
  const d = h.community?.defaults;
  for (const [field, r] of [['new_member_role', d?.new_member_role], ['agents_role', d?.agents_role]] as const)
    if (r && !roles.includes(r)) add('community_role_unknown', `/community/defaults/${field}`, `${r} is not a role in governance.roles.`);

  // Glyphs (6.4, 7.3, 7.4).
  const glyphs = h.glyphs ?? [];
  const slugs = new Set<string>();
  const manifests = new Map((opts.glyphManifests ?? []).map((g) => [g.id, g]));
  const createdBy = new Map<string, string[]>();
  glyphs.forEach((entry, gi) => {
    const p = `/glyphs/${gi}`;
    const use = parseGlyphUse(entry.use);
    out.push(...scopeIssues(entry.granted, `${p}/granted`));
    if (!use) return;
    if (slugs.has(use.slug)) add('glyph_duplicate', `${p}/use`, `${use.id} is added more than once.`);
    slugs.add(use.slug);
    const g = manifests.get(use.id);
    if (!g) {
      unchecked.push(entry.use);
      return;
    }
    createdBy.set(use.slug, (g.channels ?? []).map((c) => c.id));
    if (!satisfiesRange(g.version, use.range)) add('glyph_version_mismatch', `${p}/use`, `${use.id} ${g.version} does not satisfy ${use.range}.`);
    const requested = new Set(g.permissions.requests);
    entry.granted.forEach((s, i) => {
      if (!requested.has(s))
        add('granted_exceeds_requests', `${p}/granted/${i}`, `${g.name} does not request ${s}. A Henge may grant only scopes listed in the Glyph's permissions.requests.`);
      const ch = /^post:channel:(.+)$/.exec(s)?.[1];
      if (ch && !channelIds.has(ch) && !(g.channels ?? []).some((c) => c.id === ch))
        add('glyph_channel_missing', `${p}/granted/${i}`, `${g.name} may post to #${ch}, but no such channel exists and the Glyph does not create it.`);
    });
    const runes = new Map((g.runes ?? []).map((r) => [r.id, r]));
    const known = [...channelIds, ...(g.channels ?? []).map((c) => c.id)];
    for (const [id, value] of Object.entries(entry.runes ?? {})) {
      const rune = runes.get(id);
      if (!rune) add('rune_unknown', `${p}/runes/${id}`, `${g.name} has no Rune named ${id}.`);
      else out.push(...checkRuneValue(rune, value, `${p}/runes/${id}`, { roles, channels: known }));
    }
  });

  // A channel's glyph_posts must name an added Glyph; a Glyph only posts where a channel exists or it creates one.
  for (const c of channels)
    c.glyph_posts.forEach((slug, i) => {
      if (!slugs.has(slug)) add('community_glyph_not_added', `${c.path}/glyph_posts/${i}`, `#${c.id} lets the ${slug} Glyph post, but that Glyph is not added.`);
    });

  if (!slugs.has(h.governance.voting.glyph))
    add('voting_glyph_not_added', '/governance/voting/glyph', `Voting is provided by the ${h.governance.voting.glyph} Glyph, which is not in glyphs[].`);

  return { issues: out, unchecked };
}

/** Schema plus every single-file invariant. An unknown spec major is refused before anything else. */
export function validateHenge(value: unknown, opts: ValidateHengeOptions = {}): HengeResult {
  const ver = (value as { henge?: unknown } | null)?.henge;
  if (typeof ver === 'string' && /^\d+\.\d+$/.test(ver) && Number(ver.split('.')[0]) !== HENGE_SPEC_MAJOR)
    return { ok: false, issues: [{ code: 'henge_unknown_major', path: '/henge', message: `This client reads .henge v${HENGE_SPEC_MAJOR}.x; the file is v${ver}.` }] };
  const v = hengeValidators().henge;
  if (!v(value)) return { ok: false, issues: schemaIssues(v.errors) };
  const henge = value as HengeV1;
  const { issues, unchecked } = hengeInvariants(henge, opts);
  return issues.length ? { ok: false, issues } : { ok: true, henge, unchecked };
}

/** YAML or JSON text in, validated `.henge` file out. */
export function parseHenge(source: string, opts: ValidateHengeOptions = {}): HengeResult {
  const parsed = parseManifestSource(source);
  return parsed.ok ? validateHenge(parsed.value, opts) : parsed;
}

/* ----------------------------------------------------------------------------------------------- */
/* Bundle rules                                                                                     */
/* ----------------------------------------------------------------------------------------------- */

/** A bundle in memory: bundle-relative path (forward slashes) to bytes. */
export type HengeBundleFiles = ReadonlyMap<string, Uint8Array>;

export interface ValidateBundleOptions extends ValidateHengeOptions {
  /** Paths whose archive or git mode carries an executable bit. */
  executableBits?: ReadonlySet<string>;
  /** Files of the previously pinned version, for the append-only learnings rule. */
  previousFiles?: HengeBundleFiles;
}

const td = new TextDecoder('utf-8', { fatal: true });
const startsWith = (b: Uint8Array, ...sig: number[]) => sig.every((x, i) => b[i] === x);

/** Native binaries, WebAssembly and scripts with a shebang, whatever their extension. */
export function looksExecutable(path: string, data: Uint8Array): boolean {
  if (hasExt(path, EXECUTABLE_EXTENSIONS)) return true;
  return (
    startsWith(data, 0x7f, 0x45, 0x4c, 0x46) || // ELF
    startsWith(data, 0x4d, 0x5a) || // PE (MZ)
    startsWith(data, 0xcf, 0xfa, 0xed, 0xfe) || startsWith(data, 0xce, 0xfa, 0xed, 0xfe) || // Mach-O
    startsWith(data, 0xfe, 0xed, 0xfa, 0xce) || startsWith(data, 0xfe, 0xed, 0xfa, 0xcf) ||
    startsWith(data, 0xca, 0xfe, 0xba, 0xbe) || // Mach-O universal or Java class
    startsWith(data, 0x00, 0x61, 0x73, 0x6d) || // WebAssembly
    startsWith(data, 0x23, 0x21) // #!
  );
}

function isText(data: Uint8Array): boolean {
  if (data.includes(0)) return false;
  try {
    td.decode(data);
    return true;
  } catch {
    return false;
  }
}

/** A bundle path must stay inside the bundle: relative, forward slashes, no `.` or `..` segments. */
export function isSafeBundlePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const lines = (data: Uint8Array | undefined) => (data ? new TextDecoder().decode(data).split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')) : []);

/** Append-only learnings (6.4): every line of every previous log must still be there, unchanged and in order. */
export function learningsAppendOnlyIssues(learningsPath: string, previous: HengeBundleFiles, next: HengeBundleFiles): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  const dir = learningsPath.endsWith('/') ? learningsPath : `${learningsPath}/`;
  for (const [p, data] of previous) {
    if (!(p === learningsPath || p.startsWith(dir)) || !p.endsWith('.jsonl')) continue;
    const before = lines(data);
    const after = lines(next.get(p));
    const firstDiff = before.findIndex((l, i) => after[i] !== l);
    if (!next.has(p)) out.push({ code: 'learnings_not_append_only', path: p, message: `${p} was removed. Learnings are append-only.` });
    else if (firstDiff !== -1) out.push({ code: 'learnings_not_append_only', path: p, message: `${p} line ${firstDiff + 1} was removed or edited. Learnings are append-only: add new lines only.` });
  }
  return out;
}

/**
 * Validate a whole `<slug>.henge/` bundle: `henge.yaml` against the schema and invariants, the
 * bundle's own Glyph manifests, safe paths, no executables outside `benchmarks/scorer/`, text-only
 * strategies and learnings, and (given the previous version) append-only learnings.
 */
export function validateHengeBundle(files: HengeBundleFiles, opts: ValidateBundleOptions = {}): HengeResult {
  const issues: ManifestIssue[] = [];
  for (const p of files.keys()) if (!isSafeBundlePath(p)) issues.push({ code: 'bundle_unsafe_path', path: p, message: `${p} is not a safe bundle path.` });
  const manifest = files.get('henge.yaml');
  if (!manifest) return { ok: false, issues: [...issues, { code: 'bundle_missing_manifest', path: 'henge.yaml', message: 'A .henge bundle needs henge.yaml at its root.' }] };

  // Glyph manifests shipped inside the bundle: glyphs/<name>.glyph/glyph.yaml or glyphs/<name>.glyph.yaml.
  const local: GlyphManifestV1[] = [];
  for (const [p, data] of files) {
    if (!/^glyphs\/[^/]+\.glyph(\/glyph\.yaml|\.yaml)$/.test(p)) continue;
    const parsed = parseManifestSource(new TextDecoder().decode(data));
    const r = parsed.ok ? validateGlyph(parsed.value) : parsed;
    if (r.ok) local.push(r.glyph);
    else issues.push(...r.issues.map((i) => ({ ...i, path: `${p}#${i.path}` })));
  }

  const r = parseHenge(new TextDecoder().decode(manifest), { glyphManifests: [...(opts.glyphManifests ?? []), ...local] });
  if (!r.ok) return { ok: false, issues: [...issues, ...r.issues] };
  const h = r.henge;

  const strategyPaths = new Set((h.strategies ?? []).map((s) => s.path));
  const learnDir = h.learnings ? (h.learnings.path.endsWith('/') ? h.learnings.path : `${h.learnings.path}/`) : null;
  for (const [p, data] of files) {
    if (!p.startsWith(SCORER_DIR) && (looksExecutable(p, data) || opts.executableBits?.has(p)))
      issues.push({ code: 'bundle_executable_file', path: p, message: `${p} is executable. Code may live only under ${SCORER_DIR}; the scorer runs in henge-bench CI, never on member machines.` });
    if (strategyPaths.has(p) && !isText(data)) issues.push({ code: 'strategy_not_text', path: p, message: `${p} is not UTF-8 text. Strategies are prompts and procedures only.` });
    if (learnDir && (p === h.learnings!.path || p.startsWith(learnDir)) && (!hasExt(p, LEARNINGS_EXTENSIONS) || !isText(data)))
      issues.push({ code: 'learnings_not_text', path: p, message: `${p}: learnings are text only (${LEARNINGS_EXTENSIONS.join(', ')}).` });
  }
  if (opts.previousFiles && h.learnings) issues.push(...learningsAppendOnlyIssues(h.learnings.path, opts.previousFiles, files));

  return issues.length ? { ok: false, issues } : r;
}

/* ----------------------------------------------------------------------------------------------- */
/* Updates and joining                                                                              */
/* ----------------------------------------------------------------------------------------------- */

const glyphView = (h: HengeV1, part: 'add' | 'permissions' | 'runes') => {
  const entries = (h.glyphs ?? []).map((g) => ({ id: parseGlyphUse(g.use)?.id ?? g.use, g })).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (part === 'add') return entries.map((e) => e.id);
  if (part === 'permissions') return Object.fromEntries(entries.map((e) => [e.id, [...e.g.granted].sort()]));
  return Object.fromEntries(entries.map((e) => [e.id, e.g.runes ?? {}]));
};

function lookupPath(h: HengeV1, dotted: string): { found: boolean; value: unknown } {
  let cur: unknown = h;
  for (const k of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in (cur as object))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[k];
  }
  return { found: true, value: cur };
}

/**
 * The value a `rule_updates` field path names. `glyphs.add`, `glyphs.permissions` and
 * `glyphs.runes` are views over `glyphs[]`. A path that names nothing in either version
 * (for example `participation.limits`, which v1 does not define) falls back to its nearest
 * existing parent, so a change is never missed.
 */
function fieldValue(prev: HengeV1, next: HengeV1, dotted: string): [unknown, unknown] {
  if (dotted === 'glyphs.add' || dotted === 'glyphs.permissions' || dotted === 'glyphs.runes' || dotted.startsWith('glyphs.runes.')) {
    const part = dotted === 'glyphs.add' ? 'add' : dotted === 'glyphs.permissions' ? 'permissions' : 'runes';
    return [glyphView(prev, part), glyphView(next, part)];
  }
  let path = dotted;
  for (;;) {
    const a = lookupPath(prev, path);
    const b = lookupPath(next, path);
    if (a.found || b.found || !path.includes('.')) return [a.value, b.value];
    path = path.slice(0, path.lastIndexOf('.'));
  }
}

const differs = (a: unknown, b: unknown) => canonicalJson(a ?? null) !== canonicalJson(b ?? null);

function semverGreater(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]!;
  return false;
}

export interface HengeUpdateCheck {
  /** Refusals: the update must not be applied. */
  issues: ManifestIssue[];
  /** `member_reconsent_on` fields that changed: the node pauses until the member re-confirms (6.4). */
  reconsent: string[];
  /** `vote_required_for` fields that changed: the change needed a passed member vote before merge. */
  voteRequired: string[];
}

/**
 * Compare a fetched update with the pinned version (6.4, 6.5 step 5). Both lists of field paths are
 * taken from the previous and the next file together, so an update cannot drop a field from
 * `member_reconsent_on` to dodge re-consent for that same change.
 */
export function checkHengeUpdate(prev: HengeV1, next: HengeV1, files?: { previous: HengeBundleFiles; next: HengeBundleFiles }): HengeUpdateCheck {
  const issues: ManifestIssue[] = [];
  if (prev.id === next.id && differs(prev.governance.constitution.immutable, next.governance.constitution.immutable))
    issues.push({ code: 'constitution_changed_without_new_id', path: '/governance/constitution/immutable', message: 'The immutable constitution can change only together with a new Henge id.' });
  const strip = (h: HengeV1) => {
    const { signatures: _s, source: _src, ...rest } = h;
    return rest;
  };
  if (differs(strip(prev), strip(next)) && !semverGreater(next.version, prev.version))
    issues.push({ code: 'version_not_bumped', path: '/version', message: `Every change bumps the bundle version; ${next.version} is not newer than ${prev.version}.` });
  if (files && next.learnings) issues.push(...learningsAppendOnlyIssues(next.learnings.path, files.previous, files.next));

  const union = (k: 'member_reconsent_on' | 'vote_required_for') => [...new Set([...prev.governance.rule_updates[k], ...next.governance.rule_updates[k]])];
  const changed = (paths: string[]) => paths.filter((p) => differs(...fieldValue(prev, next, p)));
  return { issues, reconsent: changed(union('member_reconsent_on')), voteRequired: changed(union('vote_required_for')) };
}

/** The member's own limits, chosen on the Participation screen and kept on the device. */
export interface MemberParticipation {
  daily_cap?: number | null;
  monthly_cap?: number | null;
}

/** Can this member finish joining? A cap marked `required: true` must be set first (6.4). */
export function checkJoinReadiness(h: HengeV1, member: MemberParticipation): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  const b = h.participation.budget;
  if (b.daily_cap.required && (member.daily_cap ?? null) === null)
    out.push({ code: 'budget_daily_cap_required', path: '/participation/budget/daily_cap', message: `Set a daily spending cap (${b.currency}) before joining this Henge.` });
  if (b.monthly_cap?.required && (member.monthly_cap ?? null) === null)
    out.push({ code: 'budget_monthly_cap_required', path: '/participation/budget/monthly_cap', message: `Set a monthly spending cap (${b.currency}) before joining this Henge.` });
  return out;
}
