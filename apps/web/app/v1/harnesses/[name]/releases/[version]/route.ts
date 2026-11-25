import { harnessReleaseSchema, semverSchema, slugSchema } from '@swarm-explorer/api-client';
import { getHarnessRelease } from '@swarm-explorer/db';
import { apiError, json, PUBLIC_CACHE, toHarnessRelease } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Signed release metadata (SPEC 13.1). Harness names are unique across the curated catalog. */
export async function GET(req: Request, { params }: { params: Promise<{ name: string; version: string }> }) {
  const p = await params;
  const name = slugSchema.safeParse(p.name);
  const version = semverSchema.safeParse(p.version);
  if (!name.success || !version.success) return apiError(400, 'invalid_release', 'Use a harness name and a semver version.');
  const row = await getHarnessRelease(name.data, version.data);
  if (!row) return apiError(404, 'not_found', 'No reviewed release with that name and version.');
  const bundle = new URL(`/v1/harnesses/${name.data}/releases/${version.data}/bundle`, req.url).toString();
  return json(harnessReleaseSchema, toHarnessRelease(row, row.release.revokedAt ? null : bundle), { headers: { 'cache-control': PUBLIC_CACHE } });
}
