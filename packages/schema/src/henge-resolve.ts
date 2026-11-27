/**
 * `.henge` URL resolution and fetching (spin-out spec v2, 6.5), for the client and the /s preview.
 *
 * - https only; every hop's host is resolved first and refused if any address is private,
 *   loopback, link-local or otherwise not public. Redirects are followed by hand (max 5) and
 *   checked the same way.
 * - GitHub blob URLs become raw.githubusercontent.com URLs. GitHub tree URLs that name a
 *   `*.henge/` folder are pinned to a commit and fetched through the contents API.
 * - `.henge.zip` and `.henge.tar.gz` are extracted in memory.
 * - Caps: manifest 256 KB, each landing asset 2 MB, whole bundle 25 MB.
 *
 * Fetch and DNS lookup are injected (`ResolveDeps`). The caller's fetch must connect to an
 * address it has checked itself (pin the socket), or DNS rebinding can defeat the check.
 * `createNodeResolveDeps` in `henge-fetch-node.ts` (exported from `./node`) does that.
 */
import { extractTar, extractZip, HengeArchiveError, inflate, rootArchive } from './henge-archive';
import { hengeBundleDigest } from './henge-digest';
import type { HengeV1 } from './henge-v1';
import { validateHengeBundle, type HengeBundleFiles, type ValidateHengeOptions } from './henge-validate';
import type { Digest, ManifestIssue } from './types';

export const HENGE_MANIFEST_MAX_BYTES = 256 * 1024;
export const HENGE_LANDING_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const HENGE_BUNDLE_MAX_BYTES = 25 * 1024 * 1024;
export const HENGE_MAX_REDIRECTS = 5;

export interface ResolveDeps {
  fetch: (url: string, init: { method: 'GET'; redirect: 'manual'; headers: Record<string, string> }) => Promise<Response>;
  lookup: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
  /**
   * Test only, never in production. Exact host names (for example `localhost`) that may be fetched
   * over plain http. Such a host must resolve to loopback addresses only.
   */
  insecureLocalHosts?: readonly string[];
}

/** What the client stores when a member joins (6.5 step 5). */
export interface HengePin {
  url: string;
  commit: string | null;
  etag: string | null;
  bundle_digest: Digest;
  version: string;
}

export type HengeResolveResult =
  | { ok: true; henge: HengeV1; files: Map<string, Uint8Array>; pin: HengePin; unchecked: string[] }
  | { ok: false; issues: ManifestIssue[] };

export class HengeResolveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* ----------------------------------------------------------------------------------------------- */
/* Addresses                                                                                        */
/* ----------------------------------------------------------------------------------------------- */

function parseV4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.map(Number);
}

function parseV6(s: string): number[] | null {
  let str = s.toLowerCase().split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (v4) {
    const b = parseV4(v4[1]!);
    if (!b) return null;
    str = `${str.slice(0, -v4[1]!.length)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...rest];
  } else groups = head;
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const inV4 = (b: number[], net: number[], bits: number) => {
  const a = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const n = ((net[0]! << 24) | (net[1]! << 16) | (net[2]! << 8) | net[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (n & mask);
};

/** IANA special-purpose IPv4 blocks that are never a public web server. */
const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

/** True only for a globally routable unicast address. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return !V4_BLOCKED.some(([net, bits]) => inV4(v4, net, bits));
  const g = parseV6(ip.replace(/^\[|\]$/g, ''));
  if (!g) return false;
  const embedded = [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicAddress(embedded.join('.')); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicAddress(embedded.join('.')); // NAT64
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::, ::1, IPv4-compatible
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && g[1]! < 0x0200) return false; // 2001::/23 IETF special purpose (Teredo, benchmarking)
  if (first === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4
  if (first === 0x0064 && g[1] === 0xff9b) return false; // local-use NAT64
  if (first === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard
  return (first & 0xe000) === 0x2000; // global unicast 2000::/3
}

/** True for 127.0.0.0/8, ::1 and IPv4-mapped loopback. Used only for test-only local hosts. */
export function isLoopbackAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return v4[0] === 127;
  const g = parseV6(ip.replace(/^\[|\]$/g, ''));
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && g[6]! >> 8 === 127;
}

/** The URL's host without IPv6 brackets, lowercased. */
export const urlHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

/** The address rule for one host: public addresses, or loopback only for a test-only local host. */
export function addressRule(host: string, insecureLocalHosts: readonly string[] | undefined): { local: boolean; ok: (ip: string) => boolean } {
  const local = !!insecureLocalHosts?.includes(host);
  return { local, ok: local ? isLoopbackAddress : isPublicAddress };
}

/** https only (or http for a test-only local host), and no credentials in the URL. */
export function checkUrlShape(url: URL, insecureLocalHosts?: readonly string[]): void {
  const { local } = addressRule(urlHost(url), insecureLocalHosts);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new HengeResolveError('not_https', `Only https URLs are allowed: ${url.protocol}//${url.host}`);
  if (url.username || url.password) throw new HengeResolveError('url_credentials', 'URLs with embedded credentials are refused.');
}

async function checkHost(url: URL, deps: ResolveDeps) {
  checkUrlShape(url, deps.insecureLocalHosts);
  const host = urlHost(url);
  const rule = addressRule(host, deps.insecureLocalHosts);
  if (!rule.local && (host === 'localhost' || host.endsWith('.localhost'))) throw new HengeResolveError('private_address', `${host} is a loopback name.`);
  const literal = parseV4(host) || host.includes(':') ? [{ address: host }] : null;
  const addrs = literal ?? (await deps.lookup(host).catch((err: unknown) => {
    throw new HengeResolveError('dns_failed', `Could not resolve ${host}: ${String(err)}`);
  }));
  if (!addrs.length) throw new HengeResolveError('dns_failed', `${host} has no address.`);
  const bad = addrs.find((a) => !rule.ok(a.address));
  if (bad) throw new HengeResolveError('private_address', `${host} resolves to ${bad.address}, which is not a public address.`);
}

async function readCapped(res: Response, max: number, what: string): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new HengeResolveError('too_large', `${what} is larger than ${max} bytes.`);
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    total += r.value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new HengeResolveError('too_large', `${what} is larger than ${max} bytes.`);
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** GET with https-only, public-address checks on every hop, at most five redirects and a byte cap. */
export async function safeFetch(start: string, deps: ResolveDeps, max: number, what: string, headers: Record<string, string> = {}): Promise<{ url: string; data: Uint8Array; etag: string | null }> {
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    throw new HengeResolveError('bad_url', `Not a URL: ${start}`);
  }
  const seen = new Set<string>();
  for (let hops = 0; ; hops++) {
    await checkHost(url, deps);
    seen.add(url.href);
    const res = await deps.fetch(url.href, { method: 'GET', redirect: 'manual', headers });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location')!, url);
      if (seen.has(next.href)) throw new HengeResolveError('redirect_loop', `Redirect loop at ${next.href}`);
      if (hops + 1 > HENGE_MAX_REDIRECTS) throw new HengeResolveError('too_many_redirects', `More than ${HENGE_MAX_REDIRECTS} redirects.`);
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new HengeResolveError('http_status', `${url.href} answered ${res.status}.`);
    return { url: url.href, data: await readCapped(res, max, what), etag: res.headers.get('etag') };
  }
}

/* ----------------------------------------------------------------------------------------------- */
/* URL forms                                                                                        */
/* ----------------------------------------------------------------------------------------------- */

export type HengeSource =
  | { kind: 'file'; url: string }
  | { kind: 'archive'; url: string; format: 'zip' | 'tar.gz' }
  | { kind: 'github_tree'; owner: string; repo: string; ref: string; path: string };

/** `https://github.com/o/r/blob/<ref>/<path>` becomes `https://raw.githubusercontent.com/o/r/<ref>/<path>`. */
export function githubBlobToRaw(input: string): string | null {
  const m = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(input.split(/[?#]/)[0]!);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : null;
}

/**
 * Classify a `.henge` URL. Tree URLs take the first segment after `tree/` as the ref, so a
 * branch name containing `/` must be given as a commit or tag without slashes.
 */
export function classifyHengeUrl(input: string): HengeSource {
  const raw = githubBlobToRaw(input) ?? input;
  const tree = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/.exec(raw.split(/[?#]/)[0]!);
  if (tree) {
    const path = decodeURIComponent(tree[4]!);
    if (!/(^|\/)[^/]+\.henge$/.test(path)) throw new HengeResolveError('not_a_henge_folder', 'A GitHub tree URL must point at a <slug>.henge/ folder.');
    return { kind: 'github_tree', owner: tree[1]!, repo: tree[2]!, ref: decodeURIComponent(tree[3]!), path };
  }
  const pathname = (() => {
    try {
      return new URL(raw).pathname.toLowerCase();
    } catch {
      throw new HengeResolveError('bad_url', `Not a URL: ${input}`);
    }
  })();
  if (pathname.endsWith('.henge.zip')) return { kind: 'archive', url: raw, format: 'zip' };
  if (pathname.endsWith('.henge.tar.gz')) return { kind: 'archive', url: raw, format: 'tar.gz' };
  return { kind: 'file', url: raw };
}

/* ----------------------------------------------------------------------------------------------- */
/* Fetching                                                                                         */
/* ----------------------------------------------------------------------------------------------- */

const GH_API = 'https://api.github.com';
const GH_HEADERS = { accept: 'application/vnd.github+json' };
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const json = (d: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(d));

interface ContentsEntry {
  type: string;
  path: string;
  size: number;
}

async function fetchGithubTree(src: Extract<HengeSource, { kind: 'github_tree' }>, deps: ResolveDeps): Promise<{ files: Map<string, Uint8Array>; commit: string }> {
  const repo = `${encodeURIComponent(src.owner)}/${encodeURIComponent(src.repo)}`;
  let commit = src.ref;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    const r = await safeFetch(`${GH_API}/repos/${repo}/commits/${encodeURIComponent(src.ref)}`, deps, HENGE_BUNDLE_MAX_BYTES, 'GitHub commit lookup', GH_HEADERS);
    const sha = (json(r.data) as { sha?: unknown }).sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new HengeResolveError('github_bad_response', 'GitHub did not return a commit sha.');
    commit = sha;
  }
  const raw = (p: string) => `https://raw.githubusercontent.com/${repo}/${commit}/${enc(p)}`;
  const files = new Map<string, Uint8Array>();

  // henge.yaml first, under the manifest cap, so a bad bundle fails before the rest is listed.
  const manifest = await safeFetch(raw(`${src.path}/henge.yaml`), deps, HENGE_MANIFEST_MAX_BYTES, 'henge.yaml');
  files.set('henge.yaml', manifest.data);

  const listing: ContentsEntry[] = [];
  const walk = async (dir: string) => {
    const r = await safeFetch(`${GH_API}/repos/${repo}/contents/${enc(dir)}?ref=${commit}`, deps, HENGE_BUNDLE_MAX_BYTES, 'GitHub contents listing', GH_HEADERS);
    const entries = json(r.data);
    if (!Array.isArray(entries)) throw new HengeResolveError('github_bad_response', `${dir} is not a folder.`);
    for (const e of entries as ContentsEntry[]) {
      if (e.type === 'dir') await walk(e.path);
      else if (e.type === 'symlink') throw new HengeResolveError('archive_symlink', `${e.path} is a symlink. Bundles may not contain symlinks.`);
      else if (e.type !== 'file') throw new HengeResolveError('archive_special_file', `${e.path} is a ${e.type}, not a file.`);
      else listing.push(e);
    }
  };
  await walk(src.path);
  const rel = (p: string) => p.slice(src.path.length + 1);
  const total = listing.reduce((n, e) => n + (Number(e.size) || 0), 0);
  if (total > HENGE_BUNDLE_MAX_BYTES) throw new HengeResolveError('bundle_too_large', `The bundle is larger than ${HENGE_BUNDLE_MAX_BYTES} bytes.`);
  let used = manifest.data.byteLength;
  for (const e of listing) {
    const p = rel(e.path);
    if (p === 'henge.yaml') continue;
    const r = await safeFetch(raw(e.path), deps, HENGE_BUNDLE_MAX_BYTES - used, p);
    used += r.data.byteLength;
    files.set(p, r.data);
  }
  return { files, commit };
}

/** Landing assets: everything under `landing/` plus the files `landing` names. */
function landingAssetIssues(h: HengeV1, files: HengeBundleFiles): ManifestIssue[] {
  const named = new Set([h.landing.hero_image, h.landing.icon, h.landing.body].filter((x): x is string => !!x));
  const out: ManifestIssue[] = [];
  for (const [p, d] of files)
    if ((p.startsWith('landing/') || named.has(p)) && d.byteLength > HENGE_LANDING_ASSET_MAX_BYTES)
      out.push({ code: 'landing_asset_too_large', path: p, message: `${p} is larger than ${HENGE_LANDING_ASSET_MAX_BYTES} bytes.` });
  return out;
}

const fail = (err: unknown): HengeResolveResult => {
  if (err instanceof HengeResolveError || err instanceof HengeArchiveError) return { ok: false, issues: [{ code: err.code, path: '', message: err.message }] };
  return { ok: false, issues: [{ code: 'resolve_failed', path: '', message: String(err) }] };
};

/** Fetch, extract, cap, validate and pin a `.henge` file or bundle from any supported URL. */
export async function resolveHenge(input: string, deps: ResolveDeps, opts: ValidateHengeOptions = {}): Promise<HengeResolveResult> {
  try {
    const src = classifyHengeUrl(input);
    let files: Map<string, Uint8Array>;
    let executableBits: Set<string> = new Set();
    let commit: string | null = null;
    let etag: string | null = null;
    if (src.kind === 'file') {
      const r = await safeFetch(src.url, deps, HENGE_MANIFEST_MAX_BYTES, 'The .henge file');
      files = new Map([['henge.yaml', r.data]]);
      etag = r.etag;
    } else if (src.kind === 'archive') {
      const r = await safeFetch(src.url, deps, HENGE_BUNDLE_MAX_BYTES, 'The bundle archive');
      etag = r.etag;
      const a = src.format === 'zip' ? await extractZip(r.data, HENGE_BUNDLE_MAX_BYTES) : extractTar(await inflate(r.data, 'gzip', HENGE_BUNDLE_MAX_BYTES), HENGE_BUNDLE_MAX_BYTES);
      const rooted = rootArchive(a);
      files = rooted.files;
      executableBits = rooted.executableBits;
    } else {
      const r = await fetchGithubTree(src, deps);
      files = r.files;
      commit = r.commit;
    }
    const manifest = files.get('henge.yaml');
    if (manifest && manifest.byteLength > HENGE_MANIFEST_MAX_BYTES) throw new HengeResolveError('too_large', `henge.yaml is larger than ${HENGE_MANIFEST_MAX_BYTES} bytes.`);

    const v = validateHengeBundle(files, { ...opts, executableBits });
    if (!v.ok) return v;
    const issues = landingAssetIssues(v.henge, files);
    const bundle_digest = await hengeBundleDigest(files);
    const declared = v.henge.source.bundle_digest;
    if (declared && declared !== bundle_digest) issues.push({ code: 'bundle_digest_mismatch', path: '/source/bundle_digest', message: `The file declares ${declared}, but the fetched bundle is ${bundle_digest}.` });
    if (issues.length) return { ok: false, issues };
    return { ok: true, henge: v.henge, files, unchecked: v.unchecked, pin: { url: input, commit, etag, bundle_digest, version: v.henge.version } };
  } catch (err) {
    return fail(err);
  }
}
