/**
 * Server logic for the /s link preview (spin-out spec v2, 5.2 and 6.5). Server only: the page
 * calls `previewHenge` while rendering, and the browser never fetches the .henge link itself.
 *
 * - Fetching goes through the schema resolver with the pinned Node fetch (`createNodeResolveDeps`),
 *   so https only, public addresses only on every hop, at most five redirects, and the 6.5 caps.
 * - Results are cached by URL for a short time, and concurrent requests for the same URL share
 *   one fetch. The page shows the pinned ETag and digest of what it rendered.
 * - Fetches are rate limited per client IP, in memory, per server instance. Cache hits are free.
 * - `HENGE_PREVIEW_ALLOW_LOCALHOST=1` lets the e2e suite fetch from its own http://localhost
 *   server. It is ignored whenever `VERCEL` is set, so it can never apply to a deployment.
 */
import {
  contrastRatio,
  HENGE_BUNDLE_MAX_BYTES,
  HENGE_LANDING_ASSET_MAX_BYTES,
  HENGE_MANIFEST_MAX_BYTES,
  LANDING_BACKGROUND,
  resolveHenge,
  sanitizeLandingMarkdown,
  WCAG_AA_NORMAL_TEXT,
  type HengePin,
  type HengeResolveResult,
  type HengeV1,
  type ManifestIssue,
  type ResolveDeps,
} from '@swarm-explorer/schema';
import { createNodeResolveDeps } from '@swarm-explorer/schema/node';
import type { Block } from './mini-markdown';
import type { PreviewErrorKind } from './henge-preview-copy';
import { liveHref, previewMarkdownBlocks } from './henge-preview-markdown';

export const PREVIEW_CACHE_TTL_MS = 60_000;
export const PREVIEW_CACHE_MAX = 200;
export const PREVIEW_RATE_LIMIT = { max: 20, windowMs: 60_000 };
export const PREVIEW_URL_MAX_LENGTH = 2048;
const MAX_BODY_IMAGES = 6;

/* ----------------------------------------------------------------------------------------------- */
/* Test-only localhost flag                                                                         */
/* ----------------------------------------------------------------------------------------------- */

export function localhostAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.HENGE_PREVIEW_ALLOW_LOCALHOST === '1' && !env.VERCEL;
}

export function defaultDeps(env: Record<string, string | undefined> = process.env): ResolveDeps {
  return createNodeResolveDeps({ insecureLocalHosts: localhostAllowed(env) ? ['localhost'] : undefined, userAgent: 'henge-preview (+https://henge.verafy.ai/s)' });
}

/* ----------------------------------------------------------------------------------------------- */
/* View model                                                                                       */
/* ----------------------------------------------------------------------------------------------- */

export interface PreviewGlyph {
  use: string;
  granted: string[];
  runes: string[];
  checked: boolean;
}

export interface PreviewView {
  url: string;
  deepLink: string;
  henge: Pick<HengeV1, 'id' | 'name' | 'summary' | 'description' | 'version' | 'publisher'>;
  title: string;
  tagline: string;
  accent: string | null;
  icon: string | null;
  hero: string | null;
  body: Block[] | null;
  /** Bundle path to data URL for images the body may show. */
  bodyImages: Record<string, string>;
  bodyPath: string | null;
  bodyMissing: boolean;
  sanitized: boolean;
  sections: { title: string; body: string }[];
  links: { label: string; href: string | null }[];
  admission: HengeV1['admission'];
  glyphs: PreviewGlyph[];
  pin: HengePin;
  singleFile: boolean;
}

export type PreviewResult =
  | { ok: true; view: PreviewView }
  | { ok: false; kind: PreviewErrorKind; message: string; issues: ManifestIssue[] };

const IMAGE_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };

function magicOk(type: string, d: Uint8Array): boolean {
  const at = (...b: number[]) => b.every((x, i) => d[i] === x);
  switch (type) {
    case 'image/png':
      return at(0x89, 0x50, 0x4e, 0x47);
    case 'image/jpeg':
      return at(0xff, 0xd8, 0xff);
    case 'image/gif':
      return at(0x47, 0x49, 0x46, 0x38);
    case 'image/webp':
      return at(0x52, 0x49, 0x46, 0x46) && d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50;
    case 'image/svg+xml': {
      try {
        return /<svg[\s>]/i.test(new TextDecoder('utf-8', { fatal: true }).decode(d.subarray(0, 4096)));
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * A bundle image as a data URL, only if it is a known image type whose bytes match it and it is
 * within the landing asset cap. SVG is shown through <img>, where its scripts never run.
 */
export function bundleImage(files: ReadonlyMap<string, Uint8Array>, p: string | undefined | null): string | null {
  if (!p) return null;
  const d = files.get(p);
  const ext = /\.[a-z]+$/i.exec(p)?.[0]?.toLowerCase() ?? '';
  const type = IMAGE_TYPES[ext];
  if (!d || !type || d.byteLength > HENGE_LANDING_ASSET_MAX_BYTES || !magicOk(type, d)) return null;
  return `data:${type};base64,${Buffer.from(d).toString('base64')}`;
}

/** Resolve a markdown image path relative to the markdown file, staying inside the bundle. */
export function bundleRelative(from: string, ref: string): string | null {
  const clean = ref.split(/[?#]/)[0]!;
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  const parts = from.includes('/') ? from.split('/').slice(0, -1) : [];
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/') || null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function buildView(url: string, r: Extract<HengeResolveResult, { ok: true }>): PreviewView {
  const { henge: h, files, pin } = r;
  const l = h.landing;
  const accent = l.accent && HEX.test(l.accent) && contrastRatio(l.accent, LANDING_BACKGROUND) >= WCAG_AA_NORMAL_TEXT ? l.accent : null;

  let body: Block[] | null = null;
  let sanitized = false;
  const bodyImages: Record<string, string> = {};
  const bodyData = files.get(l.body);
  if (bodyData) {
    const text = new TextDecoder().decode(bodyData);
    const s = sanitizeLandingMarkdown(text, { path: l.body, bundleFiles: files.keys() });
    sanitized = s.removed.length > 0;
    body = previewMarkdownBlocks(s.markdown);
    for (const m of s.markdown.matchAll(/!\[[^\]]*\]\(([^)\s]*)\)/g)) {
      if (Object.keys(bodyImages).length >= MAX_BODY_IMAGES) break;
      const p = bundleRelative(l.body, m[1]!);
      const src = p ? bundleImage(files, p) : null;
      if (src) bodyImages[m[1]!] = src;
    }
  }

  const unchecked = new Set(r.unchecked);
  return {
    url,
    deepLink: `henge://add?url=${encodeURIComponent(url)}`,
    henge: { id: h.id, name: h.name, summary: h.summary, description: h.description, version: h.version, publisher: h.publisher },
    title: l.title,
    tagline: l.tagline,
    accent,
    icon: bundleImage(files, l.icon),
    hero: bundleImage(files, l.hero_image),
    body,
    bodyImages,
    bodyPath: l.body,
    bodyMissing: !bodyData,
    sanitized,
    sections: (l.sections ?? []).map((s) => ({ title: s.title, body: s.body })),
    links: (l.links ?? []).map((k) => ({ label: k.label, href: liveHref(k.href) })),
    admission: h.admission,
    glyphs: (h.glyphs ?? []).map((g) => ({ use: g.use, granted: g.granted ?? [], runes: Object.keys(g.runes ?? {}), checked: !unchecked.has(g.use) })),
    pin,
    singleFile: files.size === 1,
  };
}

/* ----------------------------------------------------------------------------------------------- */
/* Errors                                                                                           */
/* ----------------------------------------------------------------------------------------------- */

const KIND_BY_CODE: Record<string, PreviewErrorKind> = {
  bad_url: 'bad_url',
  not_https: 'not_https',
  private_address: 'private_address',
  url_credentials: 'url_credentials',
  dns_failed: 'dns_failed',
  too_large: 'too_large',
  bundle_too_large: 'too_large',
  landing_asset_too_large: 'too_large',
  archive_too_large: 'too_large',
  http_status: 'http_status',
  redirect_loop: 'redirects',
  too_many_redirects: 'redirects',
  timeout: 'unreachable',
  fetch_failed: 'unreachable',
  resolve_failed: 'failed',
};

export function errorKind(issues: ManifestIssue[]): PreviewErrorKind {
  const first = issues[0]?.code ?? 'resolve_failed';
  if (KIND_BY_CODE[first]) return KIND_BY_CODE[first];
  if (/too_large|_cap$/.test(first)) return 'too_large';
  return 'invalid';
}

/** The caps, from the resolver's constants, for the "too large" message. */
export function capsText(): string {
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  return `Caps: ${kb(HENGE_MANIFEST_MAX_BYTES)} for the .henge file, ${mb(HENGE_LANDING_ASSET_MAX_BYTES)} for each landing asset, ${mb(HENGE_BUNDLE_MAX_BYTES)} for a whole bundle.`;
}

/* ----------------------------------------------------------------------------------------------- */
/* Rate limit and cache                                                                             */
/* ----------------------------------------------------------------------------------------------- */

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** True if this key may make another request now (and counts it). */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

interface CacheEntry {
  at: number;
  result: Promise<PreviewResult>;
}

export interface PreviewContext {
  ip: string;
  now?: number;
  deps?: ResolveDeps;
}

export function createPreviewer(opts: { limiter?: RateLimiter; ttlMs?: number; deps?: () => ResolveDeps } = {}) {
  const limiter = opts.limiter ?? new RateLimiter(PREVIEW_RATE_LIMIT.max, PREVIEW_RATE_LIMIT.windowMs);
  const ttl = opts.ttlMs ?? PREVIEW_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  async function run(url: string, deps: ResolveDeps): Promise<PreviewResult> {
    const r = await resolveHenge(url, deps);
    if (r.ok) return { ok: true, view: buildView(url, r) };
    const kind = errorKind(r.issues);
    return { ok: false, kind, message: r.issues[0]?.message ?? '', issues: r.issues.slice(0, 5) };
  }

  return async function previewHenge(input: string, ctx: PreviewContext): Promise<PreviewResult> {
    const now = ctx.now ?? Date.now();
    const url = input.trim();
    if (!url || url.length > PREVIEW_URL_MAX_LENGTH || !URL.canParse(url)) return { ok: false, kind: 'bad_url', message: '', issues: [] };
    const key = new URL(url).href;

    const hit = cache.get(key);
    if (hit && now - hit.at < ttl) return hit.result;
    if (!limiter.take(ctx.ip || 'unknown', now)) return { ok: false, kind: 'rate_limited', message: '', issues: [] };

    const result = run(url, ctx.deps ?? opts.deps?.() ?? defaultDeps());
    const entry: CacheEntry = { at: now, result };
    cache.set(key, entry);
    if (cache.size > PREVIEW_CACHE_MAX) cache.delete(cache.keys().next().value!);
    const settled = await result;
    // Keep successes and files that failed validation; network trouble is retried next time.
    if (!settled.ok && !['invalid', 'too_large', 'not_https', 'private_address', 'bad_url', 'url_credentials'].includes(settled.kind)) cache.delete(key);
    return settled;
  };
}

/** The process-wide previewer the /s page uses. */
export const previewHenge = createPreviewer();

/** The client IP for rate limiting: the first x-forwarded-for entry (set by Vercel), else x-real-ip. */
export function clientIp(h: { get(name: string): string | null }): string {
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || 'unknown';
}
