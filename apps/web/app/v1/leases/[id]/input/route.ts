import { leaseInputSchema } from '@swarm-explorer/api-client';
import { leaseInput } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { guardLease } from '@/lib/lease-api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/leases/{id}/input: the lease's `input.uri`. Device-signed and lease-scoped, so it stands in
 * for a signed short-lived object storage URL. Answers only while the lease is running.
 */
export const GET = withNodeAuth<{ params: Promise<{ id: string }> }>(
  async (_req, auth, { params }) => {
    const l = await guardLease(auth, (await params).id);
    if (l instanceof Response) return l;
    try {
      const r = await leaseInput({ accountId: auth.user.id, leaseId: l.id });
      return json(leaseInputSchema, { lease_id: l.id, input: r.input, input_sha256: r.inputHash });
    } catch (e) {
      return membershipErrorResponse(e);
    }
  },
  { write: false },
);
