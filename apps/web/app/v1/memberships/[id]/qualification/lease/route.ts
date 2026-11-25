import { qualificationLeaseSchema } from '@swarm-explorer/api-client';
import { leaseQualificationTask } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { guardMembership, membershipErrorResponse, toQualification } from '@/lib/membership-api';
import { withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** POST /v1/memberships/{id}/qualification/lease (SPEC 13.2): the next known-answer task. Never includes the answer. */
export const POST = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, auth, { params }) => {
  const m = await guardMembership(auth, (await params).id);
  if (m instanceof Response) return m;
  try {
    const l = await leaseQualificationTask({ accountId: auth.user.id, membershipId: m.id });
    return json(qualificationLeaseSchema, { qualification: toQualification(l.qualification)!, task: { id: l.task.id, input: l.task.input as Record<string, unknown> }, deadline_at: l.deadlineAt.toISOString() });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
