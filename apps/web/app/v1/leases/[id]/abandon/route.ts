import { leaseAbandonedSchema, leaseAbandonSchema } from '@swarm-explorer/api-client';
import { abandonLease } from '@swarm-explorer/db';
import { apiError, json } from '@/lib/api';
import { guardLease } from '@/lib/lease-api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** POST /v1/leases/{id}/abandon (SPEC 13.3): an immediate, unpaid return from Pause, leave or a rule stop. */
export const POST = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, auth, { params }) => {
  const l = await guardLease(auth, (await params).id);
  if (l instanceof Response) return l;
  const parsed = leaseAbandonSchema.safeParse(parseJsonBody(auth.body));
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send the reason for abandoning.');
  try {
    const r = await abandonLease({ accountId: auth.user.id, leaseId: l.id, reason: parsed.data.reason });
    return json(leaseAbandonedSchema, { lease_id: r.id, status: r.status, requeued: r.requeuedAt !== null });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
