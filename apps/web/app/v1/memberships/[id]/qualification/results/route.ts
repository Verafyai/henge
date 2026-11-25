import { createHash } from 'node:crypto';
import { qualificationResultSchema, qualificationScoredSchema } from '@swarm-explorer/api-client';
import { submitQualificationResult } from '@swarm-explorer/db';
import { canonicalJson } from '@swarm-explorer/schema';
import { apiError, json } from '@/lib/api';
import { guardMembership, membershipErrorResponse, membershipView, toQualification } from '@/lib/membership-api';
import { parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/memberships/{id}/qualification/results (SPEC 13.2): score one known-answer result.
 * The output hash must match the output, so the run record describes what was sent.
 */
export const POST = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, auth, { params }) => {
  const m = await guardMembership(auth, (await params).id);
  if (m instanceof Response) return m;
  const parsed = qualificationResultSchema.safeParse(parseJsonBody(auth.body));
  if (!parsed.success) return apiError(400, 'invalid_body', 'The qualification result does not match the schema.', { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const digest = `sha256-${createHash('sha256').update(canonicalJson(parsed.data.output)).digest('hex')}`;
  if (digest !== parsed.data.output_sha256) return apiError(400, 'output_hash_mismatch', 'output_sha256 does not match the output.');
  try {
    const r = await submitQualificationResult({ accountId: auth.user.id, membershipId: m.id, taskId: parsed.data.task_id, output: parsed.data.output, outputHash: digest });
    const view = await membershipView(auth.user.id, m.nodeId, m.id);
    return json(qualificationScoredSchema, { correct: r.correct, qualification: toQualification(r.qualification)!, membership: view! });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
