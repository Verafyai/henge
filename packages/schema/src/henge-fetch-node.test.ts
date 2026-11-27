import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeResolveDeps, type ResolvedAddress } from './henge-fetch-node';
import { HENGE_MANIFEST_MAX_BYTES, HengeResolveError, isLoopbackAddress, resolveHenge, safeFetch } from './henge-resolve';

const EXAMPLE = readFileSync(path.resolve(import.meta.dirname, '..', 'fixtures', 'henge', 'valid', 'example.henge.yaml'));
const PUBLIC = '93.184.215.14';

/** A local server that records every request it gets. */
function startServer(handler: http.RequestListener, tls?: { key: string; cert: string }) {
  const hits: http.IncomingMessage[] = [];
  const wrapped: http.RequestListener = (req, res) => {
    hits.push(req);
    handler(req, res);
  };
  const server = tls ? https.createServer(tls, wrapped) : http.createServer(wrapped);
  return new Promise<{ port: number; hits: http.IncomingMessage[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, hits, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A resolver that answers from a script: each host gets its answers in order, then repeats the last. */
function scriptedDns(script: Record<string, string[][]>) {
  const calls: string[] = [];
  const seen: Record<string, number> = {};
  const resolve = async (host: string): Promise<ResolvedAddress[]> => {
    calls.push(host);
    const answers = script[host];
    if (!answers) throw new Error(`ENOTFOUND ${host}`);
    const i = Math.min(seen[host] ?? 0, answers.length - 1);
    seen[host] = (seen[host] ?? 0) + 1;
    return answers[i]!.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolve, calls };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof HengeResolveError ? e.code : `other: ${String(e)}`;
  }
};
const codes = (r: { ok: boolean; issues?: { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code));

describe('isLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.9.9.9', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['10.0.0.1', false],
    [PUBLIC, false],
    ['::', false],
  ])('%s', (ip, want) => expect(isLoopbackAddress(ip)).toBe(want));
});

describe('createNodeResolveDeps: pinning', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer((req, res) => {
      if (req.url === '/example.henge.yaml') {
        res.writeHead(200, { 'content-type': 'application/yaml', etag: '"ex1"' });
        res.end(EXAMPLE);
      } else if (req.url === '/to-private') {
        res.writeHead(302, { location: `https://intranet.test:${srv.port}/example.henge.yaml` });
        res.end();
      } else if (req.url === '/big') {
        // Chunked, no content-length: only the streamed cap can stop it.
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 40 && res.write(chunk)) sent++;
          if (sent < 40) res.once('drain', pump);
          else res.end();
        };
        pump();
      } else if (req.url === '/hang') {
        res.writeHead(200);
        res.write('henge: "1.0"\n');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  afterAll(() => srv.close());

  it('refuses a rebinding answer: the check sees a public address, the connection would see 127.0.0.1', async () => {
    const dns = scriptedDns({ 'rebind.test': [[PUBLIC], ['127.0.0.1']] });
    const deps = createNodeResolveDeps({ resolve: dns.resolve });
    const before = srv.hits.length;
    // safeFetch's own check gets the public answer; the fetch resolves again and gets loopback.
    expect(await codeOf(safeFetch(`https://rebind.test:${srv.port}/example.henge.yaml`, deps, HENGE_MANIFEST_MAX_BYTES, 'x'))).toBe('private_address');
    expect(dns.calls).toEqual(['rebind.test', 'rebind.test']);
    expect(srv.hits.length).toBe(before);
  });

  it('refuses when any answer is private, and never connects', async () => {
    const dns = scriptedDns({ 'mixed.test': [[PUBLIC, '127.0.0.1']] });
    const deps = createNodeResolveDeps({ resolve: dns.resolve });
    const before = srv.hits.length;
    expect(await codeOf(deps.fetch(`https://mixed.test:${srv.port}/`, { method: 'GET', redirect: 'manual', headers: {} }))).toBe('private_address');
    expect(srv.hits.length).toBe(before);
  });

  it('refuses private literals, localhost and http without connecting', async () => {
    const deps = createNodeResolveDeps({ resolve: scriptedDns({ localhost: [['127.0.0.1']] }).resolve });
    const get = (u: string) => codeOf(deps.fetch(u, { method: 'GET', redirect: 'manual', headers: {} }));
    const before = srv.hits.length;
    expect(await get(`https://127.0.0.1:${srv.port}/`)).toBe('private_address');
    expect(await get(`https://[::1]:${srv.port}/`)).toBe('private_address');
    expect(await get(`https://localhost:${srv.port}/`)).toBe('private_address');
    expect(await get(`http://localhost:${srv.port}/`)).toBe('not_https');
    expect(await get(`https://user:pw@example.org/`)).toBe('url_credentials');
    expect(srv.hits.length).toBe(before);
  });

  it('connects to the pinned address even if DNS changes its answer after the check', async () => {
    // A test-only local host must resolve to loopback. The later answer would point elsewhere.
    const dns = scriptedDns({ 'henge.test': [['127.0.0.1'], ['127.0.0.1'], ['10.0.0.9']] });
    const deps = createNodeResolveDeps({ resolve: dns.resolve, insecureLocalHosts: ['henge.test'] });
    const r = await resolveHenge(`http://henge.test:${srv.port}/example.henge.yaml`, deps);
    expect(codes(r)).toEqual([]);
    expect(r.ok && r.pin.etag).toBe('"ex1"');
    const last = srv.hits[srv.hits.length - 1]!;
    expect(last.headers.host).toBe(`henge.test:${srv.port}`);
    expect(last.headers['accept-encoding']).toBe('identity');
    // The third answer (10.0.0.9) is refused for a local host on the next request.
    expect(await codeOf(deps.fetch(`http://henge.test:${srv.port}/example.henge.yaml`, { method: 'GET', redirect: 'manual', headers: {} }))).toBe('private_address');
  });

  it('re-checks every redirect hop', async () => {
    const dns = scriptedDns({ 'henge.test': [['127.0.0.1']], 'intranet.test': [['10.1.2.3']] });
    const deps = createNodeResolveDeps({ resolve: dns.resolve, insecureLocalHosts: ['henge.test'] });
    const r = await resolveHenge(`http://henge.test:${srv.port}/to-private`, deps);
    expect(codes(r)).toEqual(['private_address']);
    expect(dns.calls).toContain('intranet.test');
  });

  it('stops a chunked body at the cap while streaming', async () => {
    const deps = createNodeResolveDeps({ resolve: scriptedDns({ 'henge.test': [['127.0.0.1']] }).resolve, insecureLocalHosts: ['henge.test'] });
    expect(codes(await resolveHenge(`http://henge.test:${srv.port}/big`, deps))).toEqual(['too_large']);
    // The transport cap holds on its own too, below the caller's cap.
    const small = createNodeResolveDeps({ resolve: scriptedDns({ 'henge.test': [['127.0.0.1']] }).resolve, insecureLocalHosts: ['henge.test'], maxBytes: 1000 });
    expect(await codeOf(safeFetch(`http://henge.test:${srv.port}/big`, small, 10_000_000, 'x'))).toBe('too_large');
  });

  it('times out a server that stops sending', async () => {
    const deps = createNodeResolveDeps({ resolve: scriptedDns({ 'henge.test': [['127.0.0.1']] }).resolve, insecureLocalHosts: ['henge.test'], timeoutMs: 300 });
    expect(codes(await resolveHenge(`http://henge.test:${srv.port}/hang`, deps))).toEqual(['timeout']);
  });

  it('returns redirects unfollowed and maps a refused connection', async () => {
    const deps = createNodeResolveDeps({ resolve: scriptedDns({ 'henge.test': [['127.0.0.1']] }).resolve, insecureLocalHosts: ['henge.test'] });
    const res = await deps.fetch(`http://henge.test:${srv.port}/to-private`, { method: 'GET', redirect: 'manual', headers: {} });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('intranet.test');
    const closed = await startServer(() => undefined);
    await closed.close();
    expect(await codeOf(deps.fetch(`http://henge.test:${closed.port}/`, { method: 'GET', redirect: 'manual', headers: {} }))).toBe('fetch_failed');
  });
});

/** https with a throwaway self-signed certificate for henge.test, made with openssl when it is installed. */
const openssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!openssl)('createNodeResolveDeps over TLS', () => {
  let dir: string;
  let tls: { key: string; cert: string };
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'henge-tls-'));
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=henge.test', '-addext', 'subjectAltName=DNS:henge.test'],
      { stdio: 'ignore' },
    );
    tls = { key: readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
    srv = await startServer((_req, res) => {
      res.writeHead(200, { etag: '"tls"' });
      res.end(EXAMPLE);
    }, tls);
  });
  afterAll(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifies the certificate for the host name while connecting to the pinned address', async () => {
    const deps = createNodeResolveDeps({ resolve: scriptedDns({ 'henge.test': [['127.0.0.1']] }).resolve, insecureLocalHosts: ['henge.test'], ca: tls.cert });
    const r = await resolveHenge(`https://henge.test:${srv.port}/example.henge.yaml`, deps);
    expect(codes(r)).toEqual([]);
    expect(r.ok && r.pin.etag).toBe('"tls"');
  });

  it('fails TLS when the certificate does not match the host name', async () => {
    const deps = createNodeResolveDeps({ resolve: scriptedDns({ 'other.test': [['127.0.0.1']] }).resolve, insecureLocalHosts: ['other.test'], ca: tls.cert });
    expect(codes(await resolveHenge(`https://other.test:${srv.port}/example.henge.yaml`, deps))).toEqual(['fetch_failed']);
  });

  it('refuses the rebinding answer over https as well', async () => {
    const dns = scriptedDns({ 'henge.test': [[PUBLIC], ['127.0.0.1']] });
    const before = srv.hits.length;
    const deps = createNodeResolveDeps({ resolve: dns.resolve, ca: tls.cert });
    expect(codes(await resolveHenge(`https://henge.test:${srv.port}/example.henge.yaml`, deps))).toEqual(['private_address']);
    expect(srv.hits.length).toBe(before);
  });
});
