import { createHash } from 'node:crypto';
import { releasesQuerySchema } from '@swarm-explorer/api-client';
import { compareVersions, signedManifestSchema } from '@swarm-explorer/api-client/release';
import { getDb, clientReleases } from '@swarm-explorer/db';
import { and, eq, isNull } from 'drizzle-orm';
import { apiError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Stable 0 to 99 bucket per install and version, for staged rollout (SPEC 15.1). */
function bucket(installId: string, version: string): number {
  return createHash('sha256').update(`${installId}:${version}`).digest().readUInt16BE(0) % 100;
}

export async function GET(req: Request) {
  const parsed = releasesQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiError(400, 'invalid_query', 'platform, arch and channel are required.');
  const q = parsed.data;
  const db = await getDb();
  const rows = await db
    .select()
    .from(clientReleases)
    .where(and(eq(clientReleases.channel, q.channel), eq(clientReleases.platform, q.platform), eq(clientReleases.arch, q.arch), isNull(clientReleases.yankedAt)));
  const eligible = rows
    .filter((r) => r.rolloutPct >= 100 || (q.install_id ? bucket(q.install_id, r.version) < r.rolloutPct : false))
    .sort((a, b) => compareVersions(b.version, a.version));
  const latest = eligible[0];
  if (!latest) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  return json(signedManifestSchema, { manifest: latest.manifest, signature: latest.signature }, { headers: { 'cache-control': 'no-store' } });
}
