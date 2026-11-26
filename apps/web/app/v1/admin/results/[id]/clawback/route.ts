import { clawbackSchema, clawedBackSchema } from '@swarm-explorer/api-client';
import { clawBack } from '@swarm-explorer/db';
import { z } from 'zod';
import { apiError, json, requireIdempotencyKey } from '@/lib/api';
import { withBearer } from '@/lib/bearer';
import { membershipErrorResponse } from '@/lib/membership-api';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/admin/results/{id}/clawback (added M6, 2026-11-25): a platform reviewer records fraud
 * found while a result is pending (SPEC 8.3, 9.2). Pending credit returns to the pool, impact is
 * revoked and reputation drops. Settled results are refused.
 */
export const POST = withBearer<{ params: Promise<{ id: string }> }>(async (req, { user }, { params }) => {
  if (user.platformRole !== 'reviewer' && user.platformRole !== 'admin') return apiError(403, 'forbidden', 'Only platform reviewers can claw back results.');
  const idem = requireIdempotencyKey(req);
  if (idem instanceof Response) return idem;
  const id = z.uuid().safeParse((await params).id);
  const parsed = clawbackSchema.safeParse(await req.json().catch(() => null));
  if (!id.success || !parsed.success) return apiError(400, 'invalid_body', 'Send a reason for a result id.');
  try {
    const r = await clawBack({ resultId: id.data, actorAccountId: user.id, reason: parsed.data.reason });
    return json(clawedBackSchema, { result_id: id.data, status: r.status, duplicate: r.duplicate });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
