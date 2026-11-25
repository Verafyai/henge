import { releaseListSchema } from '@swarm-explorer/api-client';
import { getDb, clientReleases } from '@swarm-explorer/db';
import { desc, isNull } from 'drizzle-orm';
import { PUBLIC_CACHE, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** For the download page: every non-yanked release. */
export async function GET() {
  const db = await getDb();
  const rows = await db.select().from(clientReleases).where(isNull(clientReleases.yankedAt)).orderBy(desc(clientReleases.publishedAt));
  return json(
    releaseListSchema,
    {
      items: rows.map((r) => ({
        version: r.version,
        channel: r.channel,
        platform: r.platform,
        arch: r.arch,
        url: r.url,
        sha256: r.sha256,
        publishedAt: r.publishedAt.toISOString(),
      })),
    },
    { headers: { 'cache-control': PUBLIC_CACHE } },
  );
}
