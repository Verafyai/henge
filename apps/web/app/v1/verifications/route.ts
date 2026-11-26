import { verificationRecordedSchema, verificationSubmitSchema } from '@swarm-explorer/api-client';
import { recordWorkerVerdict } from '@swarm-explorer/db';
import { apiError, json } from '@/lib/api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { parseJsonBody } from '@/lib/node-auth';
import { withVerifierAuth } from '@/lib/verifier-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/verifications (SPEC 13.3): a signed verifier submission. The platform checks the key, the
 * record signature and the assignment (the subject waits for this method and the record names the
 * stored output) before anything moves. Idempotent per subject and method.
 */
export const POST = withVerifierAuth(async (_req, v) => {
  const parsed = verificationSubmitSchema.safeParse(parseJsonBody(v.body));
  if (!parsed.success) return apiError(400, 'invalid_body', 'The verification does not match the schema.', { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const { payload, signature } = parsed.data;
  try {
    const r = await recordWorkerVerdict({ keyId: v.keyId, payload, signature });
    return json(verificationRecordedSchema, { subject: { type: payload.subject_type, id: payload.subject_id }, status: r.status, duplicate: r.duplicate }, { status: r.duplicate ? 200 : 201 });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
