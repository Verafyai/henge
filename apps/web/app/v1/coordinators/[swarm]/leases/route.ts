import { leaseRequestSchema, leaseResponseSchema, slugSchema } from '@swarm-explorer/api-client';
import { requestLease } from '@swarm-explorer/db';
import { apiError, json } from '@/lib/api';
import { toLeaseView, unavailableMessage } from '@/lib/lease-api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { ownedNode, parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/coordinators/{swarm}/leases (SPEC 13.3): a node pulls work from the hosted coordinator.
 * Returns zero or one lease. The node always initiates; the coordinator never connects to it.
 */
export const POST = withNodeAuth<{ params: Promise<{ swarm: string }> }>(async (req, { user, install, body }, { params }) => {
  const slug = slugSchema.safeParse((await params).swarm);
  const parsed = leaseRequestSchema.safeParse(parseJsonBody(body));
  if (!slug.success || !parsed.success) return apiError(400, 'invalid_body', 'Send node_id, mode and the model artifact hash you will run.');
  if (!(await ownedNode(user, install.id, parsed.data.node_id))) return apiError(404, 'not_found', 'No such node.');
  try {
    const r = await requestLease({
      accountId: user.id,
      nodeId: parsed.data.node_id,
      slug: slug.data,
      modelArtifactHash: parsed.data.model_artifact_hash,
      idempotencyKey: req.headers.get('idempotency-key')!,
    });
    return json(leaseResponseSchema, {
      lease: r.grant ? toLeaseView(r.grant, new URL(req.url).origin) : null,
      unavailable: r.reason ? { code: r.reason, message: unavailableMessage[r.reason] } : null,
    }, { status: r.grant ? 201 : 200 });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
