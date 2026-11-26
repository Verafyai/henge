/**
 * Glyph manifest v1 (spin-out spec v2, 7.2) and the permission scope rules (7.3).
 * A Glyph is what a Henge adds to gain a power; a Rune is one configurable rule inside it.
 */
import { hengeValidators, schemaIssues } from './henge-ajv';
import type { GlyphManifestV1, GlyphResult, RuneV1 } from './henge-v1';
import { MODEL_PROVIDER_DOMAINS } from './invariants';
import { DOMAIN } from './json-schema';
import type { ManifestIssue } from './types';
import { parseManifestSource } from './yaml';

/** Every scope a Glyph may request (7.3). `network:<domain>` must name one exact domain. */
export const GLYPH_SCOPE_PATTERN =
  /^(read:(members|messages|benchmarks|learnings|strategies|henge_file)|post:(channel:[a-z0-9-]+|audit_log)|propose:henge_file|tally:votes|run:benchmark|append:learnings|inject:agent_context|treasury:(hold|pay)|moderate:(delete|timeout|kick|ban|pause_member)|network:[a-z0-9.-]+)$/;

/** Scopes that always need a member vote to grant, unless the Henge owner is the only member (7.3). */
export const VOTE_GATED_SCOPES = ['treasury:pay', 'moderate:ban'] as const;

const DOMAIN_RE = new RegExp(DOMAIN);
const underDomain = (host: string, d: string) => host === d || host.endsWith(`.${d}`);

/** The 7.3 rules that apply to any list of scopes, requested or granted. */
export function scopeIssues(scopes: readonly unknown[], basePath: string): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  scopes.forEach((s, i) => {
    const path = `${basePath}/${i}`;
    if (typeof s !== 'string') return;
    if (s.startsWith('network:')) {
      const host = s.slice('network:'.length);
      if (host.includes('*')) out.push({ code: 'scope_network_wildcard', path, message: `${s}: network wildcards are refused. Name each domain exactly.` });
      else if (!DOMAIN_RE.test(host)) out.push({ code: 'scope_network_not_domain', path, message: `${s}: a network scope must name one lowercase domain, not an IP address or a single label.` });
      else if (MODEL_PROVIDER_DOMAINS.some((d) => underDomain(host, d)))
        out.push({ code: 'scope_network_model_provider', path, message: `${s}: ${host} is a model provider. Model calls go through the local proxy, never a Glyph.` });
      return;
    }
    if (!GLYPH_SCOPE_PATTERN.test(s)) out.push({ code: 'scope_unknown', path, message: `${s} is not a Glyph permission scope.` });
  });
  return out;
}

/* ----------------------------------------------------------------------------------------------- */
/* Runes                                                                                            */
/* ----------------------------------------------------------------------------------------------- */

export interface RuneContext {
  /** Role names defined by the Henge (`governance.roles`). When given, `roles` Runes must use them. */
  roles?: readonly string[];
  /** Channel ids that exist or that the Glyph creates. When given, `channel` Runes must name one. */
  channels?: readonly string[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inOptions = (options: unknown[] | undefined, v: unknown) => !options || options.some((o) => JSON.stringify(o) === JSON.stringify(v));

/**
 * Does `value` fit this Rune's type, min, max and options? `null` always fits: it means "not set"
 * (for example the Treasury Glyph's payout before a pool is funded).
 */
export function checkRuneValue(rune: RuneV1, value: unknown, path: string, ctx: RuneContext = {}): ManifestIssue[] {
  if (value === null) return [];
  const out: ManifestIssue[] = [];
  const bad = (expected: string) => out.push({ code: 'rune_type_mismatch', path, message: `Rune ${rune.id} expects ${expected}.` });
  const range = (v: number) => {
    if (rune.min !== undefined && v < rune.min) out.push({ code: 'rune_below_min', path, message: `Rune ${rune.id} must be at least ${rune.min}.` });
    if (rune.max !== undefined && v > rune.max) out.push({ code: 'rune_above_max', path, message: `Rune ${rune.id} must be at most ${rune.max}.` });
  };
  const options = () => {
    if (!inOptions(rune.options, value)) out.push({ code: 'rune_not_in_options', path, message: `Rune ${rune.id} must be one of: ${(rune.options ?? []).map(String).join(', ')}.` });
  };
  switch (rune.type) {
    case 'boolean':
      if (typeof value !== 'boolean') bad('true or false');
      break;
    case 'number':
      if (!isNum(value)) bad('a number');
      else range(value);
      break;
    case 'integer':
      if (!Number.isInteger(value)) bad('a whole number');
      else range(value as number);
      break;
    case 'percent':
      if (!isNum(value) || value < 0 || value > 1) bad('a fraction from 0 to 1');
      else range(value);
      break;
    case 'duration':
      // The unit comes from the Rune's `unit`; the value is a non-negative number of that unit.
      if (!isNum(value) || value < 0) bad('a non-negative number');
      else range(value);
      break;
    case 'enum':
      if (!rune.options) out.push({ code: 'rune_enum_without_options', path, message: `Rune ${rune.id} is an enum with no options.` });
      else options();
      break;
    case 'string':
      if (typeof value !== 'string') bad('text');
      else options();
      break;
    case 'list':
      if (!Array.isArray(value)) bad('a list');
      else if (rune.options) value.forEach((v, i) => {
        if (!inOptions(rune.options, v)) out.push({ code: 'rune_not_in_options', path: `${path}/${i}`, message: `Rune ${rune.id} items must be one of: ${rune.options!.map(String).join(', ')}.` });
      });
      break;
    case 'roles':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) bad('a list of role names');
      else value.forEach((v: string, i) => {
        if (ctx.roles && !ctx.roles.includes(v)) out.push({ code: 'rune_unknown_role', path: `${path}/${i}`, message: `Rune ${rune.id}: ${v} is not a role in this Henge.` });
        else if (!inOptions(rune.options, v)) out.push({ code: 'rune_not_in_options', path: `${path}/${i}`, message: `Rune ${rune.id}: ${v} is not an allowed role.` });
      });
      break;
    case 'channel':
      if (typeof value !== 'string') bad('a channel id');
      else if (ctx.channels && !ctx.channels.includes(value)) out.push({ code: 'rune_unknown_channel', path, message: `Rune ${rune.id}: channel ${value} does not exist and this Glyph does not create it.` });
      break;
  }
  return out;
}

/** Who must approve a change to this Rune. `none` only for cosmetic Runes when the Henge exempts them. */
export function runeApprover(rune: RuneV1, opts: { cosmeticExempt?: boolean } = {}): 'vote' | 'maintainer' | 'owner' | 'none' {
  if (rune.cosmetic && opts.cosmeticExempt) return 'none';
  return rune.change_requires ?? 'vote';
}

/** True when changing this Rune must go through a Governance Glyph proposal (7.6). */
export function isVoteGated(rune: RuneV1, opts: { cosmeticExempt?: boolean } = {}): boolean {
  return runeApprover(rune, opts) === 'vote';
}

export interface RuneChangePlan {
  /** Changes that may apply now, after the named approver (if any) confirms. */
  direct: Record<string, unknown>;
  approvers: Record<string, 'maintainer' | 'owner' | 'none'>;
  /** Vote-gated changes: these open a proposal and take effect only when it passes. */
  proposal: Record<string, unknown>;
  issues: ManifestIssue[];
}

/**
 * Sort a batch of Rune edits (7.6) into those that need a proposal and those that do not.
 * Invalid values or unknown Rune ids are reported and go nowhere.
 */
export function planRuneChanges(glyph: GlyphManifestV1, changes: Record<string, unknown>, opts: RuneContext & { cosmeticExempt?: boolean } = {}): RuneChangePlan {
  const plan: RuneChangePlan = { direct: {}, approvers: {}, proposal: {}, issues: [] };
  const byId = new Map((glyph.runes ?? []).map((r) => [r.id, r]));
  for (const [id, value] of Object.entries(changes)) {
    const rune = byId.get(id);
    const path = `/runes/${id}`;
    if (!rune) {
      plan.issues.push({ code: 'rune_unknown', path, message: `${glyph.id} has no Rune named ${id}.` });
      continue;
    }
    const issues = checkRuneValue(rune, value, path, opts);
    if (issues.length) {
      plan.issues.push(...issues);
      continue;
    }
    const who = runeApprover(rune, opts);
    if (who === 'vote') plan.proposal[id] = value;
    else {
      plan.direct[id] = value;
      plan.approvers[id] = who;
    }
  }
  return plan;
}

/* ----------------------------------------------------------------------------------------------- */
/* Manifest validation                                                                              */
/* ----------------------------------------------------------------------------------------------- */

/** Cross-field rules for one Glyph manifest. Assumes the schema passed. */
export function glyphInvariants(g: GlyphManifestV1): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  if (!/ Glyph$/.test(g.name)) out.push({ code: 'glyph_name_suffix', path: '/name', message: `A Glyph's display name ends in "Glyph", for example "Governance Glyph".` });
  out.push(...scopeIssues(g.permissions.requests, '/permissions/requests'));
  const seen = new Set<string>();
  (g.runes ?? []).forEach((r, i) => {
    const p = `/runes/${i}`;
    if (seen.has(r.id)) out.push({ code: 'rune_duplicate', path: `${p}/id`, message: `Rune ${r.id} is declared twice.` });
    seen.add(r.id);
    if (r.type === 'enum' && !r.options?.length) out.push({ code: 'rune_enum_without_options', path: `${p}/options`, message: `Rune ${r.id} is an enum and needs options.` });
    if (r.min !== undefined && r.max !== undefined && r.min > r.max) out.push({ code: 'rune_min_above_max', path: `${p}/min`, message: `Rune ${r.id} has min above max.` });
    if (r.default !== undefined) out.push(...checkRuneValue(r, r.default, `${p}/default`));
  });
  const channels = new Set<string>();
  (g.channels ?? []).forEach((c, i) => {
    if (channels.has(c.id)) out.push({ code: 'glyph_channel_duplicate', path: `/channels/${i}/id`, message: `Channel ${c.id} is declared twice.` });
    channels.add(c.id);
  });
  return out;
}

/** Schema plus every Glyph rule. Wildcard network scopes are reported with their own code, not only as a pattern failure. */
export function validateGlyph(value: unknown): GlyphResult {
  const v = hengeValidators().glyph;
  if (!v(value)) {
    const requests = (value as { permissions?: { requests?: unknown } })?.permissions?.requests;
    const scoped = Array.isArray(requests) ? scopeIssues(requests, '/permissions/requests') : [];
    const covered = new Set(scoped.map((i) => i.path));
    return { ok: false, issues: [...scoped, ...schemaIssues(v.errors).filter((i) => !covered.has(i.path))] };
  }
  const glyph = value as GlyphManifestV1;
  const issues = glyphInvariants(glyph);
  return issues.length ? { ok: false, issues } : { ok: true, glyph };
}

/** YAML or JSON text in, validated Glyph manifest out. */
export function parseGlyph(source: string): GlyphResult {
  const parsed = parseManifestSource(source);
  return parsed.ok ? validateGlyph(parsed.value) : parsed;
}

/* ----------------------------------------------------------------------------------------------- */
/* Granting scopes                                                                                  */
/* ----------------------------------------------------------------------------------------------- */

export interface GlyphGrantRequest {
  glyph: GlyphManifestV1;
  granted: readonly string[];
  /** What this Henge granted the Glyph before; only newly granted vote-gated scopes need a vote. */
  previouslyGranted?: readonly string[];
  /** Members of the Henge, humans only. 1 means the owner alone (the caller checks it is the owner). */
  memberCount: number;
  /** A Governance Glyph proposal granting these scopes has passed. */
  votePassed: boolean;
}

/**
 * Check one grant (7.3, 7.7): every granted scope must be requested by the manifest, no wildcards,
 * and `treasury:pay` or `moderate:ban` need a passed vote unless the owner is the only member.
 */
export function checkGlyphGrant(req: GlyphGrantRequest): ManifestIssue[] {
  const out = scopeIssues(req.granted, '/granted');
  const requested = new Set(req.glyph.permissions.requests);
  req.granted.forEach((s, i) => {
    if (!requested.has(s))
      out.push({ code: 'granted_exceeds_requests', path: `/granted/${i}`, message: `${req.glyph.name} does not request ${s}, so it cannot be granted. A Henge may grant only scopes listed in the Glyph's permissions.requests.` });
  });
  const before = new Set(req.previouslyGranted ?? []);
  const gated = req.granted.filter((s) => (VOTE_GATED_SCOPES as readonly string[]).includes(s) && !before.has(s));
  if (gated.length && !req.votePassed && req.memberCount > 1)
    out.push({ code: 'scope_requires_vote', path: '/granted', message: `Granting ${gated.join(' and ')} needs a member vote, because this Henge has more than one member.` });
  return out;
}

/* ----------------------------------------------------------------------------------------------- */
/* Versions                                                                                         */
/* ----------------------------------------------------------------------------------------------- */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Split `<publisher>/<glyph>@<range>`. */
export function parseGlyphUse(use: string): { id: string; publisher: string; slug: string; range: string } | null {
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)@(.+)$/.exec(use);
  return m ? { id: `${m[1]}/${m[2]}`, publisher: m[1]!, slug: m[2]!, range: m[3]! } : null;
}

/**
 * Minimal semver range check for Glyph `use` entries: an exact version, `^x.y.z` or `~x.y.z`.
 * A prerelease version satisfies only a range that names that same prerelease.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const op = range[0] === '^' || range[0] === '~' ? range[0] : '';
  const v = SEMVER_RE.exec(version);
  const r = SEMVER_RE.exec(op ? range.slice(1) : range);
  if (!v || !r) return false;
  const [vm, vn, vp] = [Number(v[1]), Number(v[2]), Number(v[3])];
  const [rm, rn, rp] = [Number(r[1]), Number(r[2]), Number(r[3])];
  if (v[4] || r[4]) return vm === rm && vn === rn && vp === rp && v[4] === r[4];
  const gte = vm > rm || (vm === rm && (vn > rn || (vn === rn && vp >= rp)));
  if (!op) return vm === rm && vn === rn && vp === rp;
  if (!gte) return false;
  if (op === '~') return vm === rm && vn === rn;
  if (rm > 0) return vm === rm;
  if (rn > 0) return vm === 0 && vn === rn;
  return vm === 0 && vn === 0 && vp === rp;
}
