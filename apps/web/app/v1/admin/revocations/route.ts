import { killSwitchRecordedSchema, killSwitchRequestSchema } from '@swarm-explorer/api-client';
import { setKillSwitch } from '@swarm-explorer/db';
import { apiError, json, requireIdempotencyKey } from '@/lib/api';
import { withBearer } from '@/lib/bearer';
import { membershipErrorResponse } from '@/lib/membership-api';
import { toRevocationEntry } from '@/lib/revocations';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/admin/revocations (SPEC 11.6, 13.4; built M7): the kill switch. A platform admin stops all
 * work (`target: platform`) or one swarm, or restores it. The entry is signed with the platform
 * revocation key and published in the feed; a stop cancels every open lease in scope at once.
 * Admin role only, with an Idempotency-Key scoped to the admin.
 */
export const POST = withBearer(async (req, { user }) => {
  if (user.platformRole !== 'admin') return apiError(403, 'forbidden', 'Only platform admins can use the kill switch.');
  const idem = requireIdempotencyKey(req);
  if (idem instanceof Response) return idem;
  const parsed = killSwitchRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send target (platform or swarm), the swarm for a swarm stop, action (revoke or restore) and a reason.');
  try {
    const r = await setKillSwitch({
      target: parsed.data.target,
      ...(parsed.data.swarm ? { swarm: parsed.data.swarm } : {}),
      action: parsed.data.action,
      reason: parsed.data.reason,
      actorAccountId: user.id,
      idempotencyKey: `${user.id}:${idem.key}`,
    });
    return json(killSwitchRecordedSchema, { revocation: toRevocationEntry(r.entry), duplicate: r.duplicate, cancelled_leases: r.cancelledLeases });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
