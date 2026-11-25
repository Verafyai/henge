import { membershipLeftSchema } from '@swarm-explorer/api-client';
import { leaveMembership } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { guardMembership, membershipErrorResponse } from '@/lib/membership-api';
import { withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** DELETE /v1/memberships/{id} (SPEC 13.2): leave now. Revokes grants and abandons open leases; earned credits stay. */
export const DELETE = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, auth, { params }) => {
  const m = await guardMembership(auth, (await params).id);
  if (m instanceof Response) return m;
  try {
    const r = await leaveMembership({ accountId: auth.user.id, membershipId: m.id });
    return json(membershipLeftSchema, { id: m.id, left_at: r.leftAt.toISOString(), abandoned_leases: r.abandonedLeases });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
