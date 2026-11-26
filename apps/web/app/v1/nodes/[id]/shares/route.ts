import { sharesUpdatedSchema, sharesUpdateSchema } from '@swarm-explorer/api-client';
import { setShares } from '@swarm-explorer/db';
import { z } from 'zod';
import { apiError, json } from '@/lib/api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { ownedNode, parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** PATCH /v1/nodes/{id}/shares (SPEC 13.2, 7.1): atomically set normalized basis points summing to 10,000. */
export const PATCH = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, { user, install, body }, { params }) => {
  const id = z.uuid().safeParse((await params).id);
  const parsed = sharesUpdateSchema.safeParse(parseJsonBody(body));
  if (!id.success || !parsed.success) return apiError(400, 'invalid_body', 'Send a share for every qualified swarm.');
  if (!(await ownedNode(user, install.id, id.data))) return apiError(404, 'not_found', 'No such node.');
  try {
    const r = await setShares({ accountId: user.id, nodeId: id.data, shares: parsed.data.shares.map((s) => ({ membershipId: s.membership_id, shareBp: s.share_bp })) });
    return json(sharesUpdatedSchema, { node_id: id.data, customized: r.customized, shares: r.shares.map((s) => ({ membership_id: s.membershipId, share_bp: s.shareBp })) });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
