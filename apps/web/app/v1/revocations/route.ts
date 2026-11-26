import { revocationFeedSchema, revocationsQuerySchema } from '@swarm-explorer/api-client';
import { listPlatformKeys, listRevocations } from '@swarm-explorer/db';
import { apiError, json } from '@/lib/api';
import { toRevocationEntry } from '@/lib/revocations';

export const dynamic = 'force-dynamic';

/**
 * Signed revocation feed (SPEC 11.6). Nodes poll it and must check it before any new or
 * resumed task, so it is never cached. Each entry carries its own signed payload and signature;
 * nodes read the kill state from the signed payload only. `keys` lists the feed's signing keys.
 */
export async function GET(req: Request) {
  const q = revocationsQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return apiError(400, 'invalid_query', 'since must be an ISO 8601 timestamp with offset.');
  const [rows, keys] = await Promise.all([listRevocations(q.data.since ? new Date(q.data.since) : null), listPlatformKeys('revocation')]);
  const items = rows.map(toRevocationEntry);
  return json(revocationFeedSchema, { items, next: items.at(-1)?.effectiveAt ?? q.data.since ?? null, keys }, { headers: { 'cache-control': 'no-store' } });
}
