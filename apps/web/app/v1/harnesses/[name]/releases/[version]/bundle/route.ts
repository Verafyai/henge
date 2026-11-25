import { readFileSync } from 'node:fs';
import path from 'node:path';
import { localBundleDir } from '@/lib/bundles';
import { bundleArchiveSchema, semverSchema, slugSchema } from '@swarm-explorer/api-client';
import { getHarnessRelease } from '@swarm-explorer/db';
import { bundleDigest, bundleIndex } from '@swarm-explorer/schema/node';
import { apiError, json, PUBLIC_CACHE } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Local bundle host (development and tests). Serves a reviewed harness release's files as one
 * archive. Staging and production publish bundles to GitHub Releases instead (decision
 * 2026-11-25). The node never trusts the host: it checks the digest and the publisher signature.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string; version: string }> }) {
  const p = await params;
  const name = slugSchema.safeParse(p.name);
  const version = semverSchema.safeParse(p.version);
  if (!name.success || !version.success) return apiError(400, 'invalid_release', 'Use a harness name and a semver version.');
  const row = await getHarnessRelease(name.data, version.data);
  if (!row || row.release.revokedAt) return apiError(404, 'not_found', 'No reviewed release with that name and version.');
  const dir = localBundleDir(name.data);
  let digest: string;
  try {
    digest = bundleDigest(dir);
  } catch {
    return apiError(404, 'bundle_unavailable', 'This release has no bundle on this host.');
  }
  if (digest !== row.release.bundleHash) return apiError(404, 'bundle_unavailable', 'This host does not have the bundle for this release.');
  const files = Object.fromEntries(bundleIndex(dir).map((f) => [f.path, readFileSync(path.join(dir, f.path)).toString('base64')]));
  return json(bundleArchiveSchema, { format: 'henge-bundle-v1', bundleHash: digest, files }, { headers: { 'cache-control': PUBLIC_CACHE } });
}
