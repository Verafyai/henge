import { releaseReviewedSchema, releaseReviewSchema } from '@swarm-explorer/api-client';
import { reviewSwarmRelease } from '@swarm-explorer/db';
import { z } from 'zod';
import { apiError, json, requireIdempotencyKey } from '@/lib/api';
import { withBearer } from '@/lib/bearer';
import { membershipErrorResponse } from '@/lib/membership-api';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/admin/reviews/{id} (SPEC 13.4): release review stub. A platform reviewer approves,
 * rejects or returns a swarm release in review. Approval publishes it; members whose permissions
 * changed must approve again before any more work.
 */
export const POST = withBearer<{ params: Promise<{ id: string }> }>(async (req, { user }, { params }) => {
  if (user.platformRole !== 'reviewer' && user.platformRole !== 'admin') return apiError(403, 'forbidden', 'Only platform reviewers can review releases.');
  const idem = requireIdempotencyKey(req);
  if (idem instanceof Response) return idem;
  const id = z.uuid().safeParse((await params).id);
  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    raw = null;
  }
  const parsed = releaseReviewSchema.safeParse(raw);
  if (!id.success || !parsed.success) return apiError(400, 'invalid_body', 'Send outcome, checklist and rationale for a release id.');
  try {
    const r = await reviewSwarmRelease({ reviewerId: user.id, releaseId: id.data, ...parsed.data });
    return json(releaseReviewedSchema, { release_id: id.data, review_status: r.reviewStatus, reconsent_required: r.reconsentRequired, moved: r.moved });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
