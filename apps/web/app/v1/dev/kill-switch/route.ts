import { killSwitchRecordedSchema, killSwitchRequestSchema } from '@swarm-explorer/api-client';
import { accounts, getDb, setKillSwitch } from '@swarm-explorer/db';
import { eq } from 'drizzle-orm';
import { apiError, json } from '@/lib/api';
import { devSignInEnabled } from '@/lib/auth/session';
import { membershipErrorResponse } from '@/lib/membership-api';
import { toRevocationEntry } from '@/lib/revocations';

export const dynamic = 'force-dynamic';

/**
 * Development and tests only: uses the kill switch as the seeded example admin, so the desktop e2e can
 * stop work mid-task without an admin sign in. It calls the same `setKillSwitch` as the real admin route
 * (`POST /v1/admin/revocations`), so the entry is signed and the feed is the real one. 404 when dev sign
 * in is disabled (always on Vercel production); the custom header forces a CORS preflight.
 */
export async function POST(req: Request) {
  if (!devSignInEnabled()) return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
  if (req.headers.get('x-dev-tool') !== '1') return apiError(403, 'forbidden', 'Development tool only.');
  const parsed = killSwitchRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send target, swarm, action and reason.');
  const db = await getDb();
  const [admin] = await db.select().from(accounts).where(eq(accounts.handle, 'admin')).limit(1);
  if (!admin || admin.platformRole !== 'admin') return apiError(409, 'no_admin', 'The seeded example admin is missing. Run pnpm db:reset.');
  try {
    const r = await setKillSwitch({
      target: parsed.data.target,
      ...(parsed.data.swarm ? { swarm: parsed.data.swarm } : {}),
      action: parsed.data.action,
      reason: parsed.data.reason,
      actorAccountId: admin.id,
      idempotencyKey: `dev:${crypto.randomUUID()}`,
    });
    return json(killSwitchRecordedSchema, { revocation: toRevocationEntry(r.entry), duplicate: r.duplicate, cancelled_leases: r.cancelledLeases });
  } catch (e) {
    return membershipErrorResponse(e);
  }
}
