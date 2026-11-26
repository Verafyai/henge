import { resultListSchema } from '@swarm-explorer/api-client';
import { resultsFor, runVerificationPass } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { withBearer } from '@/lib/bearer';
import { pipelineDeps } from '@/lib/verifier-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/me/results (added M6, 2026-11-25): the caller's recent results with their real state
 * (Submitted, Verifying, Pending, Settled, Rejected, Clawed back), when each state was reached, and
 * the impact or credits each really earned. Verifier rationale is not shown, so a node cannot tell
 * which tasks were hidden known answers.
 */
export const GET = withBearer(async (_req, { user }) => {
  await runVerificationPass(pipelineDeps());
  const items = await resultsFor(user.id);
  return json(resultListSchema, {
    items: items.map((r) => ({
      result_id: r.resultId,
      lease_id: r.leaseId,
      swarm: r.swarm,
      swarm_name: r.swarmName,
      funded: r.funded,
      state: r.state,
      disposition: r.disposition,
      timeline: r.timeline,
      impact: r.impact,
      credits: r.credits,
      submitted_at: r.submittedAt,
    })),
  });
});
