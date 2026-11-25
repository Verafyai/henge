import { revocationFeedSchema, revocationsQuerySchema } from '@swarm-explorer/api-client';
import { listRevocations } from '@swarm-explorer/db';
import { apiError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Signed revocation feed (SPEC 11.6). Nodes poll it and must check it before any new or
 * resumed task, so it is never cached. Each entry carries its own signed payload.
 */
export async function GET(req: Request) {
  const q = revocationsQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return apiError(400, 'invalid_query', 'since must be an ISO 8601 timestamp with offset.');
  const rows = await listRevocations(q.data.since ? new Date(q.data.since) : null);
  const items = rows.map((r) => ({
    id: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    severity: r.severity,
    signedPayload: r.signedPayload,
    effectiveAt: r.effectiveAt.toISOString(),
  }));
  return json(revocationFeedSchema, { items, next: items.at(-1)?.effectiveAt ?? q.data.since ?? null }, { headers: { 'cache-control': 'no-store' } });
}
