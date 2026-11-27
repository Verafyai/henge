/**
 * Production fetch for the `.henge` resolver (spin-out spec v2, 6.5), Node only (node:http,
 * node:https, node:dns). Exported from `@swarm-explorer/schema/node`, never from the browser-safe
 * index.
 *
 * DNS rebinding: `safeFetch` checks every hop's addresses before it calls `fetch`, but a hostile
 * DNS server can answer that check with a public address and the connection with 127.0.0.1. So
 * this fetch resolves the host again itself, refuses the request if any answer is not public,
 * and hands the socket a `lookup` that returns exactly the approved address. The connection
 * cannot reach any address that was not checked. TLS still verifies the certificate for the
 * host name (SNI), so pinning the address does not weaken https.
 *
 * Also: no redirects are followed here (`safeFetch` follows them by hand and re-checks each hop),
 * no keep-alive pool (every request opens its own pinned socket), `accept-encoding: identity`
 * (no decompression bombs), a whole-request timeout and a streamed byte cap.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { addressRule, checkUrlShape, HENGE_BUNDLE_MAX_BYTES, HengeResolveError, urlHost, type ResolveDeps } from './henge-resolve';

export type ResolvedAddress = { address: string; family: 4 | 6 };

export interface NodeResolveOptions {
  /** DNS resolution. Defaults to the OS resolver (`dns.lookup` with every answer). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Whole request, from connect to the last body byte. Default 15 seconds. */
  timeoutMs?: number;
  /** Hard cap on any one response body, enforced while streaming. Default: the 25 MB bundle cap. */
  maxBytes?: number;
  /** Test only, never in production: exact host names that may use http and must resolve to loopback. */
  insecureLocalHosts?: readonly string[];
  /** Extra trusted CA certificates (tests with a self-signed server). */
  ca?: string | Buffer;
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function osResolve(hostname: string): Promise<ResolvedAddress[]> {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/** Resolve and check a host; return the one address the socket will use (IPv4 first). */
async function approveAddress(host: string, resolve: NodeResolveOptions['resolve'] & {}, insecureLocalHosts?: readonly string[]): Promise<ResolvedAddress> {
  const rule = addressRule(host, insecureLocalHosts);
  if (!rule.local && (host === 'localhost' || host.endsWith('.localhost'))) throw new HengeResolveError('private_address', `${host} is a loopback name.`);
  const literal = isIP(host);
  const addrs: ResolvedAddress[] = literal
    ? [{ address: host, family: literal === 6 ? 6 : 4 }]
    : await resolve(host).catch((err: unknown) => {
        throw new HengeResolveError('dns_failed', `Could not resolve ${host}: ${String(err)}`);
      });
  if (!addrs.length) throw new HengeResolveError('dns_failed', `${host} has no address.`);
  const bad = addrs.find((a) => !rule.ok(a.address));
  if (bad) throw new HengeResolveError('private_address', `${host} resolves to ${bad.address}, which is not a public address.`);
  return addrs.find((a) => a.family === 4) ?? addrs[0]!;
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    h.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  return h;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * A `fetch` that connects only to an address it has just checked, plus the matching `lookup`.
 * Pass the result to `resolveHenge` or `safeFetch`.
 */
export function createNodeResolveDeps(opts: NodeResolveOptions = {}): ResolveDeps {
  const resolve = opts.resolve ?? osResolve;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? HENGE_BUNDLE_MAX_BYTES;
  const local = opts.insecureLocalHosts;

  const fetch: ResolveDeps['fetch'] = async (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new HengeResolveError('bad_url', `Not a URL: ${input}`);
    }
    checkUrlShape(url, local);
    const host = urlHost(url);
    const pinned = await approveAddress(host, resolve, local);

    return new Promise<Response>((done, fail) => {
      let settled = false;
      let capStream: Transform | null = null;
      const finish = (err: unknown, res?: Response) => {
        if (settled) return;
        settled = true;
        if (err) fail(err);
        else done(res!);
      };
      // The socket asks this for the address; it only ever gets the approved one.
      const pinLookup: LookupFunction = (_name, options, cb) => {
        if (options.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      };
      const mod = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = { ...init.headers, 'accept-encoding': 'identity', 'user-agent': opts.userAgent ?? 'henge-resolver' };
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: host,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: init.method,
          headers,
          lookup: pinLookup,
          agent: false,
          ...(opts.ca ? { ca: opts.ca } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if ((status >= 300 && status < 400) || NULL_BODY.has(status) || status < 200 || status > 599) {
            clearTimeout(timer);
            res.destroy();
            finish(null, new Response(null, { status: status >= 200 && status <= 599 ? status : 502, headers: toHeaders(res.headers) }));
            return;
          }
          let total = 0;
          const cap = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              total += chunk.byteLength;
              if (total > maxBytes) cb(new HengeResolveError('too_large', `The response is larger than ${maxBytes} bytes.`));
              else cb(null, chunk);
            },
          });
          capStream = cap;
          res.on('error', (e) => cap.destroy(e));
          // Closed early (cap hit, reader cancelled, timeout): drop the socket too.
          cap.on('close', () => {
            clearTimeout(timer);
            if (!res.complete) req.destroy();
          });
          res.pipe(cap);
          const body = Readable.toWeb(cap) as unknown as ReadableStream<Uint8Array>;
          finish(null, new Response(body, { status, headers: toHeaders(res.headers) }));
        },
      );
      const timer = setTimeout(() => {
        const err = new HengeResolveError('timeout', `${host} did not answer within ${timeoutMs} ms.`);
        capStream?.destroy(err);
        req.destroy(err);
        finish(err);
      }, timeoutMs);
      req.on('error', (err) => {
        clearTimeout(timer);
        finish(err instanceof HengeResolveError ? err : new HengeResolveError('fetch_failed', `Could not fetch from ${host}: ${err.message}`));
      });
      req.end();
    });
  };

  const lookup: ResolveDeps['lookup'] = (hostname) => resolve(hostname);
  return local ? { fetch, lookup, insecureLocalHosts: local } : { fetch, lookup };
}
