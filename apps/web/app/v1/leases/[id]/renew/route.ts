import { leaseRenewedSchema } from '@swarm-explorer/api-client';
import { renewLease } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { guardLease } from '@/lib/lease-api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** POST /v1/leases/{id}/renew (SPEC 13.3): optional, before the deadline; the coordinator can refuse. */
export const POST = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, auth, { params }) => {
  const l = await guardLease(auth, (await params).id);
  if (l instanceof Response) return l;
  try {
    const r = await renewLease({ accountId: auth.user.id, leaseId: l.id });
    return json(leaseRenewedSchema, { lease_id: r.id, deadline_at: r.deadlineAt.toISOString(), renewals: r.renewals });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
