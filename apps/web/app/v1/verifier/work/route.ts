import { verifierWorkSchema } from '@swarm-explorer/api-client';
import { machineCheckWork, runVerificationPass } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { pipelineDeps, withVerifierAuth } from '@/lib/verifier-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/verifier/work (added M6, 2026-11-25): the verifier worker pulls results and qualification
 * answers that wait for a machine check. Verifier-signed. Advances the lazy verification pass first,
 * so freshly submitted results are in Verifying.
 */
export const GET = withVerifierAuth(async (req) => {
  await runVerificationPass(pipelineDeps());
  const limit = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get('limit') ?? 10) || 10));
  return json(verifierWorkSchema, { items: await machineCheckWork(limit) });
});
