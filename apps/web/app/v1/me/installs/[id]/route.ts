import { can } from '@swarm-explorer/core';
import { installs, getDb } from '@swarm-explorer/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apiError, requireIdempotencyKey } from '@/lib/api';
import { revokeInstall } from '@/lib/auth/oauth';
import { withBearer } from '@/lib/bearer';

export const dynamic = 'force-dynamic';

export const DELETE = withBearer<{ params: Promise<{ id: string }> }>(async (req, { user }, { params }) => {
  const idem = requireIdempotencyKey(req);
  if (idem instanceof Response) return idem;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError(400, 'invalid_id', 'That install id is not valid.');
  const db = await getDb();
  const [target] = await db.select().from(installs).where(eq(installs.id, id.data)).limit(1);
  // Same answer for "not yours" and "does not exist", so ids cannot be probed.
  if (!target || !can(user, 'install.revoke', target)) return apiError(404, 'not_found', 'No such install.');
  await revokeInstall(target.id, user.id === target.accountId ? 'revoked_by_user' : 'revoked_by_admin');
  return new Response(null, { status: 204 });
});
