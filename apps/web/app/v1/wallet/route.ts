import { walletSchema } from '@swarm-explorer/api-client';
import { runVerificationPass, walletFor } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { withBearer } from '@/lib/bearer';
import { pipelineDeps } from '@/lib/verifier-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/wallet (SPEC 13.4): settled, pending and reserved credits and the impact summary. Credits
 * exist only for accepted work in funded swarms; volunteer work shows as impact. Settlement runs
 * lazily first, so a closed review window shows as settled.
 */
export const GET = withBearer(async (_req, { user }) => {
  await runVerificationPass(pipelineDeps());
  const w = await walletFor(user.id);
  return json(walletSchema, { credits: w.credits, impact: w.impact, has_funded_work: w.hasFundedWork });
});
