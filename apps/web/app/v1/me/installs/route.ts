import { installListSchema } from '@swarm-explorer/api-client';
import { can } from '@swarm-explorer/core';
import { installs, getDb } from '@swarm-explorer/db';
import { desc, eq } from 'drizzle-orm';
import { apiError, json } from '@/lib/api';
import { withBearer } from '@/lib/bearer';

export const dynamic = 'force-dynamic';

export const GET = withBearer(async (_req, { user, install }) => {
  if (!can(user, 'install.list', { accountId: user.id })) return apiError(403, 'forbidden', 'Not allowed.');
  const db = await getDb();
  const rows = await db.select().from(installs).where(eq(installs.accountId, user.id)).orderBy(desc(installs.lastSeenAt));
  return json(installListSchema, {
    items: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      arch: r.arch,
      version: r.clientVersion,
      channel: r.channel,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      revokedAt: r.revokedAt?.toISOString() ?? null,
      current: r.id === install.id,
    })),
  });
});
