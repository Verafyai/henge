import { permissionGrantedSchema, permissionGrantSchema } from '@swarm-explorer/api-client';
import { grantPermissions } from '@swarm-explorer/db';
import { apiError, json } from '@/lib/api';
import { guardMembership, membershipErrorResponse, membershipView } from '@/lib/membership-api';
import { parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/** POST /v1/memberships/{id}/permission-grants (SPEC 13.2): approve one exact permissions hash. */
export const POST = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, auth, { params }) => {
  const m = await guardMembership(auth, (await params).id);
  if (m instanceof Response) return m;
  const parsed = permissionGrantSchema.safeParse(parseJsonBody(auth.body));
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send the permissions_hash you approved.');
  try {
    const g = await grantPermissions({ accountId: auth.user.id, membershipId: m.id, permissionsHash: parsed.data.permissions_hash });
    const view = await membershipView(auth.user.id, m.nodeId, m.id);
    return json(permissionGrantedSchema, { membership: view!, granted_at: g.grant.grantedAt.toISOString() }, { status: 201 });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
