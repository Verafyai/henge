import { joinStartedSchema, joinStartSchema, slugSchema } from '@swarm-explorer/api-client';
import { getDb, modelArtifacts, models, qualifyingModels, startJoin } from '@swarm-explorer/db';
import { inArray, eq } from 'drizzle-orm';
import { apiError, json } from '@/lib/api';
import { membershipErrorResponse, membershipView } from '@/lib/membership-api';
import { ownedNode, parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/swarms/{id}/memberships (SPEC 13.2): start a join for one node and the current reviewed
 * release. Returns exactly the permissions to approve. Nothing runs until they are approved.
 */
export const POST = withNodeAuth<{ params: Promise<{ slug: string }> }>(async (_req, { user, install, body }, { params }) => {
  const slug = slugSchema.safeParse((await params).slug);
  const parsed = joinStartSchema.safeParse(parseJsonBody(body));
  if (!slug.success || !parsed.success) return apiError(400, 'invalid_body', 'Send node_id and the manifest_hash you reviewed.');
  if (!(await ownedNode(user, install.id, parsed.data.node_id))) return apiError(404, 'not_found', 'No such node.');
  try {
    const started = await startJoin({ accountId: user.id, nodeId: parsed.data.node_id, slug: slug.data, manifestHash: parsed.data.manifest_hash });
    const m = started.swarm.manifest;
    const fit = await qualifyingModels(parsed.data.node_id, m);
    const db = await getDb();
    const licenses = await db
      .select({ hash: modelArtifacts.contentHash, license: models.licenseId })
      .from(modelArtifacts)
      .innerJoin(models, eq(models.id, modelArtifacts.modelId))
      .where(inArray(modelArtifacts.contentHash, fit.map((f) => f.hash)));
    const view = await membershipView(user.id, parsed.data.node_id, started.membership.id);
    return json(
      joinStartedSchema,
      {
        membership: view!,
        resumed: started.resumed,
        permissions: { network: m.permissions.network, scratchDiskGb: m.permissions.scratch_disk_gb, gpuCompute: m.permissions.gpu_compute, apiSpendDailyUsd: m.permissions.api_spend_daily_usd },
        permissions_hash: started.swarm.release.permissionsHash,
        qualification: m.qualification,
        models: fit.map((f) => ({ content_hash: f.hash, display_name: f.displayName, license_id: licenses.find((l) => l.hash === f.hash)?.license ?? 'unknown' })),
      },
      { status: started.resumed ? 200 : 201 },
    );
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
