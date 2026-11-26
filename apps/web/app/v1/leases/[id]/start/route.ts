import { leaseStartedSchema, leaseStartSchema } from '@swarm-explorer/api-client';
import { startLease } from '@swarm-explorer/db';
import { apiError, json } from '@/lib/api';
import { guardLease } from '@/lib/lease-api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/leases/{id}/start: Leased to Running (SPEC 7.3, "pins and permissions verified"). The
 * node reports the harness, permissions and model it verified; the coordinator checks them against
 * the task's release and returns the input. Added to the SPEC 13.1 table in M5.
 */
export const POST = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, auth, { params }) => {
  const l = await guardLease(auth, (await params).id);
  if (l instanceof Response) return l;
  const parsed = leaseStartSchema.safeParse(parseJsonBody(auth.body));
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send harness_hash, permissions_hash and model_artifact_hash.');
  try {
    const r = await startLease({
      accountId: auth.user.id,
      leaseId: l.id,
      pins: { harnessHash: parsed.data.harness_hash, permissionsHash: parsed.data.permissions_hash, modelArtifactHash: parsed.data.model_artifact_hash },
    });
    if (!r.input) return apiError(409, 'input_unavailable', 'This task input is not stored on the hosted coordinator.');
    return json(leaseStartedSchema, { lease_id: l.id, status: 'running', deadline_at: r.lease.deadlineAt.toISOString(), input: r.input, input_sha256: r.inputHash });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
