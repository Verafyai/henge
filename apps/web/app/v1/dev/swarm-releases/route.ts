import { createHash } from 'node:crypto';
import { accounts, getDb, getSwarm, reviewSwarmRelease, swarmReleases } from '@swarm-explorer/db';
import { canonicalJson } from '@swarm-explorer/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apiError } from '@/lib/api';
import { devSignInEnabled } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ swarm: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), scratch_disk_gb: z.number().positive().max(16) }).strict();
const digest = (v: unknown) => `sha256-${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;

/**
 * Development and tests only: publish a new release of a seeded swarm with a larger scratch
 * allowance, reviewed as the seeded example reviewer, to exercise reconsent (SPEC 11.4). 404 when
 * disabled. The custom header forces a CORS preflight, so a web page cannot call it.
 */
export async function POST(req: Request) {
  if (!devSignInEnabled()) return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
  if (req.headers.get('x-dev-tool') !== '1') return apiError(403, 'forbidden', 'Development tool only.');
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send swarm and scratch_disk_gb.');
  const s = await getSwarm(parsed.data.swarm);
  if (!s) return apiError(404, 'not_found', 'No such swarm.');
  const db = await getDb();
  const [reviewer] = await db.select().from(accounts).where(eq(accounts.handle, 'reviewer')).limit(1);
  if (!reviewer) return apiError(404, 'not_found', 'No example reviewer.');
  const manifest = { ...s.manifest, permissions: { ...s.manifest.permissions, scratch_disk_gb: parsed.data.scratch_disk_gb } };
  const [rel] = await db
    .insert(swarmReleases)
    .values({
      swarmId: s.swarm.id,
      manifestVersion: 1,
      manifestJson: manifest,
      manifestHash: digest(manifest),
      harnessReleaseId: s.release.harnessReleaseId,
      coordinatorConfig: manifest.coordinator,
      // Example data: the manifest signature is carried over, so it does not cover the new permissions.
      signature: s.release.signature as object,
      permissionsHash: digest(manifest.permissions),
    })
    .returning();
  const r = await reviewSwarmRelease({ reviewerId: reviewer.id, releaseId: rel!.id, outcome: 'approved', checklist: { example: true }, rationale: 'Development tool: example permission change.' });
  return Response.json({ release_id: rel!.id, permissions_hash: rel!.permissionsHash, ...r });
}
