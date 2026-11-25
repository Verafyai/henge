/**
 * henge:// parsing with a versioned route and parameter allowlist (SPEC 4.4).
 * Anything unknown returns null and is ignored with a notice. Links never carry
 * credentials or amounts and never trigger a write by themselves. The legacy
 * swarmstarter:// scheme is not registered: SPEC 4.4 allows it only as a redirect
 * after an explicit migration mapping, which has not been approved.
 */
import type { Route } from '../shared/routes';

export const SCHEME = 'henge';
/** Bump when the allowlist changes shape, so older clients can tell links apart. */
export const DEEP_LINK_VERSION = 1;

const SLUG = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Parsed = { kind: 'navigate'; route: Route } | { kind: 'auth-callback'; url: string };

/** Query keys each link may carry. Any other key makes the link invalid. */
function onlyKeys(u: URL, allowed: string[]): boolean {
  for (const k of u.searchParams.keys()) if (!allowed.includes(k)) return false;
  return true;
}

const nav = (route: Route): Parsed => ({ kind: 'navigate', route });

export function parseDeepLink(raw: string): Parsed | null {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.username || u.password || u.port || u.hash) return null;
  // henge://swarm/x parses with host "swarm" and pathname "/x".
  let parts: string[];
  try {
    parts = [u.hostname, ...u.pathname.split('/').filter(Boolean)].map(decodeURIComponent);
  } catch {
    return null;
  }
  const [head, a, ...rest] = parts;
  if (head === 'auth') return a === 'callback' && rest.length === 0 && onlyKeys(u, ['code', 'state', 'error']) ? { kind: 'auth-callback', url: raw } : null;
  if (rest.length || !onlyKeys(u, [])) return null;

  switch (head) {
    case 'swarm':
      return a && SLUG.test(a) ? nav({ name: 'swarm', slug: a }) : null;
    case 'join':
      return a && SLUG.test(a) ? nav({ name: 'join', slug: a }) : null;
    case 'model':
      return a && SLUG.test(a) ? nav({ name: 'model', slug: a }) : null;
    case 'harness':
      return a && SLUG.test(a) ? nav({ name: 'harness', slug: a }) : null;
    case 'result':
      return a && ID.test(a) ? nav({ name: 'result', id: a }) : null;
    case 'publisher':
      return a === undefined ? nav({ name: 'publisher' }) : null;
    default:
      return null;
  }
}

/** Finds a deep link in process argv (Windows and Linux launch, second-instance). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${SCHEME}://`)) ?? null;
}
