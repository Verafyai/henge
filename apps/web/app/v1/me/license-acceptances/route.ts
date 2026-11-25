import { licenseAcceptanceSchema, licenseAcceptedSchema } from '@swarm-explorer/api-client';
import { getArtifactByHash, recordLicenseAcceptance } from '@swarm-explorer/db';
import { apiError, json } from '@/lib/api';
import { parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/me/license-acceptances: records that this user accepted a model license for one
 * artifact version (SPEC 5.4). The license named must be the one the catalog lists, so an
 * acceptance cannot be recorded against a different license.
 */
export const POST = withNodeAuth(async (_req, { user, body }) => {
  const parsed = licenseAcceptanceSchema.safeParse(parseJsonBody(body));
  if (!parsed.success) return apiError(400, 'invalid_body', 'The license acceptance does not match the schema.');
  const row = await getArtifactByHash(parsed.data.content_hash);
  if (!row) return apiError(404, 'not_found', 'No such model artifact.');
  if (row.model.licenseId !== parsed.data.license_id) return apiError(409, 'license_mismatch', 'That is not the license this model is listed under.');
  const saved = await recordLicenseAcceptance(user.id, row.artifact.id, row.model.licenseId);
  return json(licenseAcceptedSchema, { content_hash: row.artifact.contentHash, license_id: saved.licenseId, accepted_at: saved.acceptedAt.toISOString() });
});
