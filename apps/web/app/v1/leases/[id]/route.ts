import { leaseViewSchema } from '@swarm-explorer/api-client';
import { getLease } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { guardLease, toLeaseView } from '@/lib/lease-api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** GET /v1/leases/{id} (SPEC 13.3): status for recovery, after a restart or a lost reply. */
export const GET = withNodeAuth<{ params: Promise<{ id: string }> }>(
  async (req, auth, { params }) => {
    const l = await guardLease(auth, (await params).id);
    if (l instanceof Response) return l;
    try {
      const r = await getLease({ accountId: auth.user.id, leaseId: l.id });
      return json(leaseViewSchema, {
        lease: toLeaseView(r.grant, new URL(req.url).origin),
        result: r.result ? { id: r.result.id, output_sha256: r.result.outputHash, disposition: r.result.disposition, submitted_at: r.result.submittedAt.toISOString() } : null,
      });
    } catch (e) {
      return membershipErrorResponse(e);
    }
  },
  { write: false },
);
