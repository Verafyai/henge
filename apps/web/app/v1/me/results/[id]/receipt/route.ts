import { receiptEnvelopeSchema } from '@swarm-explorer/api-client';
import { receiptFor, runVerificationPass } from '@swarm-explorer/db';
import { z } from 'zod';
import { apiError, json } from '@/lib/api';
import { withBearer } from '@/lib/bearer';
import { membershipErrorResponse } from '@/lib/membership-api';
import { pipelineDeps } from '@/lib/verifier-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/me/results/{id}/receipt (M7): the signed receipt for one of the caller's settled results,
 * to view or download. Issued once and returned unchanged after that. Anyone can verify it offline.
 */
export const GET = withBearer<{ params: Promise<{ id: string }> }>(async (_req, { user }, { params }) => {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError(400, 'invalid_id', 'That result id is not valid.');
  await runVerificationPass(pipelineDeps());
  try {
    return json(receiptEnvelopeSchema, { receipt: await receiptFor({ accountId: user.id, resultId: id.data }) });
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
