import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleImage, bundleRelative, capsText, clientIp, createPreviewer, defaultDeps, errorKind, localhostAllowed, RateLimiter } from './henge-preview';
import * as copy from './henge-preview-copy';
import { parsePreviewInline, previewMarkdownBlocks } from './henge-preview-markdown';

const EXAMPLE = readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'examples', 'resolved-forecasts.henge.yaml'), 'utf8');
const FLAG = { HENGE_PREVIEW_ALLOW_LOCALHOST: '1' };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

function makeZip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = deflateRawSync(data);
    const nameB = Buffer.from(name);
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
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
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

const BUNDLE = makeZip({
  'henge.yaml': EXAMPLE,
  'strategies/base-rate-first.md': '# Base rate first (example)\n',
  'landing/README.md': '# Welcome\n\nRead the [guide](https://example.org/guide) and [rules](../GOVERNANCE.md).\n\n![chart](chart.svg)\n\n<script>alert(1)</script>\n<b onclick="x()">bold</b>\n',
  'landing/icon.svg': SVG,
  'landing/hero.svg': SVG,
  'landing/chart.svg': SVG,
});

let hits: string[] = [];
let port = 0;
let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/example.henge.yaml') {
      res.writeHead(200, { etag: '"ex"' });
      res.end(EXAMPLE);
    } else if (req.url === '/bundle.henge.zip') {
      res.writeHead(200);
      res.end(BUNDLE);
    } else if (req.url === '/big.henge') {
      res.writeHead(200);
      res.end(Buffer.alloc(300 * 1024, 0x61));
    } else if (req.url === '/bad.henge') {
      res.writeHead(200);
      res.end('henge: "1.0"\nkind: swarm\n');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const local = (p: string) => `http://localhost:${port}${p}`;
const fresh = (env: Record<string, string | undefined> = FLAG) => createPreviewer({ deps: () => defaultDeps(env) });
const ctx = { ip: '203.0.113.9' };

describe('test-only localhost flag', () => {
  it('applies only when set and never on Vercel', () => {
    expect(localhostAllowed({})).toBe(false);
    expect(localhostAllowed({ HENGE_PREVIEW_ALLOW_LOCALHOST: 'true' })).toBe(false);
    expect(localhostAllowed(FLAG)).toBe(true);
    expect(localhostAllowed({ ...FLAG, VERCEL: '1' })).toBe(false);
  });

  it('without the flag, http to localhost is refused and nothing is fetched', async () => {
    hits = [];
    const r = await fresh({})(local('/example.henge.yaml'), ctx);
    expect(r.ok ? 'ok' : r.kind).toBe('not_https');
    const onVercel = await fresh({ ...FLAG, VERCEL: '1' })(local('/example.henge.yaml'), ctx);
    expect(onVercel.ok ? 'ok' : onVercel.kind).toBe('not_https');
    expect(hits).toEqual([]);
  });

  it('with the flag, http is still refused for any other host', async () => {
    const r = await fresh()(`http://example.org/a.henge`, ctx);
    expect(r.ok ? 'ok' : r.kind).toBe('not_https');
  });
});

describe('previewHenge', () => {
  it('renders the example single file: landing, admission, Glyphs, pin and deep link', async () => {
    const r = await fresh()(local('/example.henge.yaml'), ctx);
    if (!r.ok) throw new Error(`${r.kind}: ${r.message}`);
    const v = r.view;
    expect(v.title).toBe('Resolved Forecasts');
    expect(v.tagline).toMatch(/^Forecast the past, blind/);
    expect(v.accent).toBe('#FF2A3D');
    expect(v.admission.mode).toBe('request');
    expect(v.glyphs.map((g) => g.use)).toContain('verafy/governance@^1.0.0');
    expect(v.glyphs.every((g) => !g.checked)).toBe(true);
    expect(v.pin.bundle_digest).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(v.pin.etag).toBe('"ex"');
    expect(v.deepLink).toBe(`henge://add?url=${encodeURIComponent(local('/example.henge.yaml'))}`);
    expect(v.singleFile).toBe(true);
    expect(v.bodyMissing).toBe(true);
    expect(v.icon).toBeNull();
    expect(v.sections).toHaveLength(2);
    expect(v.links.every((l) => l.href === null)).toBe(true);
  });

  it('renders a bundle: icon, hero and body images as data URLs, body sanitized', async () => {
    const r = await fresh()(local('/bundle.henge.zip'), ctx);
    if (!r.ok) throw new Error(`${r.kind}: ${r.message} ${JSON.stringify(r.issues)}`);
    const v = r.view;
    expect(v.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(v.hero).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(v.bodyImages['chart.svg']).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(v.sanitized).toBe(true);
    const text = JSON.stringify(v.body);
    expect(text).not.toContain('script');
    expect(text).not.toContain('onclick');
    expect(v.body?.[0]).toMatchObject({ type: 'heading', text: 'Welcome' });
    expect(v.singleFile).toBe(false);
  });

  it('refuses a private address, oversize and invalid files with specific errors', async () => {
    const p = fresh();
    const kind = async (u: string) => {
      const r = await p(u, ctx);
      return r.ok ? 'ok' : r.kind;
    };
    expect(await kind('https://10.0.0.1/a.henge')).toBe('private_address');
    expect(await kind('https://[fd00::1]/a.henge')).toBe('private_address');
    const off = await fresh({})('https://localhost/a.henge', ctx);
    expect(off.ok ? 'ok' : off.kind).toBe('private_address');
    expect(await kind(local('/big.henge'))).toBe('too_large');
    expect(await kind('not a url')).toBe('bad_url');
    expect(await kind('http://example.org/a.henge')).toBe('not_https');
    const bad = await p(local('/bad.henge'), ctx);
    expect(bad.ok ? 'ok' : bad.kind).toBe('invalid');
    if (!bad.ok) {
      expect(bad.issues.length).toBeGreaterThan(0);
      expect(bad.issues.length).toBeLessThanOrEqual(5);
    }
  });

  it('caches by URL and shares one fetch between concurrent requests', async () => {
    hits = [];
    const p = fresh();
    await Promise.all([p(local('/example.henge.yaml'), ctx), p(local('/example.henge.yaml'), ctx)]);
    await p(local('/example.henge.yaml'), ctx);
    expect(hits).toEqual(['/example.henge.yaml']);
  });

  it('drops the cache entry after the TTL', async () => {
    hits = [];
    const p = createPreviewer({ deps: () => defaultDeps(FLAG), ttlMs: 1000 });
    await p(local('/example.henge.yaml'), { ip: 'a', now: 0 });
    await p(local('/example.henge.yaml'), { ip: 'a', now: 500 });
    await p(local('/example.henge.yaml'), { ip: 'a', now: 1500 });
    expect(hits).toEqual(['/example.henge.yaml', '/example.henge.yaml']);
  });

  it('rate limits fetches per IP, but not cache hits', async () => {
    const p = createPreviewer({ deps: () => defaultDeps(FLAG), limiter: new RateLimiter(2, 60_000) });
    const kind = async (u: string, ip: string) => {
      const r = await p(u, { ip, now: 1000 });
      return r.ok ? 'ok' : r.kind;
    };
    expect(await kind(local('/example.henge.yaml'), 'x')).toBe('ok');
    expect(await kind(local('/example.henge.yaml'), 'x')).toBe('ok');
    expect(await kind('https://10.0.0.2/a.henge', 'x')).toBe('private_address');
    expect(await kind('https://10.0.0.3/a.henge', 'x')).toBe('rate_limited');
    expect(await kind('https://10.0.0.3/a.henge', 'y')).toBe('private_address');
  });
});

describe('RateLimiter', () => {
  it('allows max per window, then frees up', () => {
    const l = new RateLimiter(2, 1000);
    expect([l.take('a', 0), l.take('a', 10), l.take('a', 20), l.take('b', 20), l.take('a', 1005)]).toEqual([true, true, false, true, true]);
  });
});

describe('helpers', () => {
  it('maps resolver codes to calm error kinds', () => {
    const k = (code: string) => errorKind([{ code, path: '', message: '' }]);
    expect(k('bundle_too_large')).toBe('too_large');
    expect(k('archive_entry_too_large')).toBe('too_large');
    expect(k('too_many_redirects')).toBe('redirects');
    expect(k('schema_required')).toBe('invalid');
    expect(k('landing_accent_contrast')).toBe('invalid');
  });

  it('only turns real images within the cap into data URLs', () => {
    const files = new Map<string, Uint8Array>([
      ['a.svg', new TextEncoder().encode(SVG)],
      ['b.png', new TextEncoder().encode('not a png')],
      ['c.html', new TextEncoder().encode('<svg></svg>')],
      ['d.svg', new Uint8Array(2 * 1024 * 1024 + 1)],
    ]);
    expect(bundleImage(files, 'a.svg')).toMatch(/^data:image\/svg\+xml/);
    expect(bundleImage(files, 'b.png')).toBeNull();
    expect(bundleImage(files, 'c.html')).toBeNull();
    expect(bundleImage(files, 'd.svg')).toBeNull();
    expect(bundleImage(files, 'missing.svg')).toBeNull();
  });

  it('resolves bundle paths without leaving the bundle', () => {
    expect(bundleRelative('landing/README.md', 'img/a.svg')).toBe('landing/img/a.svg');
    expect(bundleRelative('landing/README.md', '../GOVERNANCE.md')).toBe('GOVERNANCE.md');
    expect(bundleRelative('landing/README.md', '../../x')).toBeNull();
    expect(bundleRelative('landing/README.md', 'https://x.example/a.svg')).toBeNull();
    expect(bundleRelative('landing/README.md', '/etc/passwd')).toBeNull();
  });

  it('renders markdown links live only for https and mailto, and drops leftover tags', () => {
    const out = parsePreviewInline('See [a](https://x.example) [b](javascript:alert(1)) [c](GOVERNANCE.md) <b>bold</b> ![i](x.svg)', () => null);
    expect(out.filter((x) => x.t === 'link')).toEqual([{ t: 'link', v: 'a', href: 'https://x.example' }]);
    expect(JSON.stringify(out)).not.toContain('<b>');
    expect(previewMarkdownBlocks('# Title\n\n#### Small\n* item')).toEqual([
      { type: 'heading', level: 2, text: 'Title', id: 'title' },
      { type: 'heading', level: 3, text: 'Small', id: 'small' },
      { type: 'list', ordered: false, items: [{ text: 'item', task: false }] },
    ]);
  });

  it('reads the client IP from the first forwarded hop', () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(clientIp(h({ 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }))).toBe('198.51.100.4');
    expect(clientIp(h({ 'x-real-ip': '198.51.100.5' }))).toBe('198.51.100.5');
    expect(clientIp(h({}))).toBe('unknown');
  });

  it('states the caps from the resolver constants', () => {
    expect(capsText()).toBe('Caps: 256 KB for the .henge file, 2 MB for each landing asset, 25 MB for a whole bundle.');
  });

  it('preview copy has no em or en dashes', () => {
    const all = JSON.stringify(copy) + Object.values(copy.preview.admission).filter((f) => typeof f === 'function').map((f) => (f as (...a: number[]) => string)(1, 2)).join(' ');
    expect(all).not.toMatch(/[–—]/);
  });
});
