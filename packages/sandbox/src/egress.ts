/**
 * Egress policy outside the harness (SPEC 11.3): network is denied unless the swarm lists the
 * exact domain. Enforced by the host, never by harness code:
 *
 * - HTTPS on port 443 only; no credentials in URLs; no IP literals.
 * - Every resolved address must be public. Private, loopback, link-local, CGNAT, multicast,
 *   unique-local and IPv4-mapped addresses are refused.
 * - The connection goes to the address we checked (DNS rebinding cannot swap it afterwards).
 * - Redirects are not followed automatically; each hop is checked again, up to a small limit.
 * - Response bodies are size-capped.
 */
import { isIP } from 'node:net';
import https from 'node:https';

export type Lookup = (host: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export type EgressDenied =
  | 'not_https'
  | 'bad_port'
  | 'credentials_in_url'
  | 'ip_literal'
  | 'domain_not_listed'
  | 'resolves_to_private_address'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'response_too_large'
  | 'method_not_allowed'
  | 'bad_url';

export class EgressError extends Error {
  constructor(readonly code: EgressDenied, detail?: string) {
    super(detail ?? code);
  }
}

function v4Private(a: string): boolean {
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [x, y] = p as [number, number, number, number];
  return (
    x === 0 || x === 10 || x === 127 || x >= 224 ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 192 && y === 0) ||
    (x === 198 && (y === 18 || y === 19))
  );
}

/** True for any address a harness must never reach. Unparseable counts as private. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return v4Private(address);
  if (kind !== 6) return true;
  const a = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  if (a === '::' || a === '::1') return true;
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return v4Private(mapped[1]!);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // Mapped v4 in hex form: refuse.
  const first = parseInt(a.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 || // multicast
    first === 0x64 || // 64:ff9b:: NAT64 can reach private v4
    first === 0x2002 || // 6to4
    first === 0 // other reserved forms
  );
}

export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/\.$/, '');
}

/** Checks the URL itself. Returns the host to resolve. */
export function checkUrl(raw: string, allowed: readonly string[]): { url: URL; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError('bad_url');
  }
  if (url.protocol !== 'https:') throw new EgressError('not_https');
  if (url.username || url.password) throw new EgressError('credentials_in_url');
  if (url.port && url.port !== '443') throw new EgressError('bad_port');
  const host = normalizeDomain(url.hostname.replace(/^\[|\]$/g, ''));
  if (isIP(host) || /^\d+$/.test(host) || /^0x/i.test(host)) throw new EgressError('ip_literal');
  if (!allowed.map(normalizeDomain).includes(host)) throw new EgressError('domain_not_listed', `${host} is not a listed domain`);
  return { url, host };
}

export async function resolvePublic(host: string, lookup: Lookup): Promise<{ address: string; family: 4 | 6 }> {
  let addrs: Array<{ address: string; family: 4 | 6 }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new EgressError('dns_failed');
  }
  if (!addrs.length) throw new EgressError('dns_failed');
  // Every answer must be public, so a mixed answer cannot be raced.
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new EgressError('resolves_to_private_address');
  return addrs[0]!;
}

export type EgressRequest = { url: string; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> };
export type EgressResponse = { status: number; headers: Record<string, string>; body: string; finalUrl: string };

/** The low-level request, injectable for tests. It must connect to `address`, not re-resolve `host`. */
export type Transport = (req: { url: URL; address: string; family: 4 | 6; method: string; headers: Record<string, string>; body?: string; maxBytes: number }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

export const httpsTransport: Transport = (r) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: r.url.hostname,
        servername: r.url.hostname,
        port: 443,
        path: `${r.url.pathname}${r.url.search}`,
        method: r.method,
        headers: r.headers,
        // Pin the connection to the checked address.
        lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, r.address, r.family),
        timeout: 30_000,
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > r.maxBytes) {
            req.destroy(new EgressError('response_too_large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (r.body) req.write(r.body);
    req.end();
  });

const SAFE_HEADERS = new Set(['accept', 'content-type', 'user-agent']);

export async function egressFetch(r: EgressRequest, policy: { allowed: readonly string[]; lookup: Lookup; transport?: Transport; maxBytes?: number; maxRedirects?: number }): Promise<EgressResponse> {
  const method = r.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') throw new EgressError('method_not_allowed');
  const headers = Object.fromEntries(Object.entries(r.headers ?? {}).filter(([k]) => SAFE_HEADERS.has(k.toLowerCase())));
  let current = r.url;
  let m = method;
  let body = r.body;
  for (let hop = 0; hop <= (policy.maxRedirects ?? 3); hop++) {
    const { url, host } = checkUrl(current, policy.allowed);
    const addr = await resolvePublic(host, policy.lookup);
    const res = await (policy.transport ?? httpsTransport)({ url, address: addr.address, family: addr.family, method: m, headers, body, maxBytes: policy.maxBytes ?? 4 * 1024 * 1024 });
    if (res.status >= 300 && res.status < 400 && res.headers['location']) {
      current = new URL(res.headers['location'], url).toString();
      if (res.status !== 307 && res.status !== 308) {
        m = 'GET';
        body = undefined;
      }
      continue;
    }
    return { ...res, finalUrl: url.toString() };
  }
  throw new EgressError('too_many_redirects');
}
