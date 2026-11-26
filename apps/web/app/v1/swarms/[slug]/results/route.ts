import { publicResultsSchema, slugSchema } from '@swarm-explorer/api-client';
import { publicSwarmResults } from '@swarm-explorer/db';
import { apiError, json, PUBLIC_CACHE } from '@/lib/api';
import { toPublicResult } from '@/lib/public-results';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/swarms/{id}/results (M7): public and unauthenticated. Only results that reached Settled,
 * with hashes, pins and the methods that accepted them, plus aggregate counts. No inputs, outputs,
 * nodes or accounts (SPEC 14).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = slugSchema.safeParse((await params).slug);
  if (!slug.success) return apiError(400, 'invalid_slug', 'That swarm id is not valid.');
  const r = await publicSwarmResults(slug.data);
  if (!r) return apiError(404, 'not_found', 'No listed swarm has that id.');
  return json(
    publicResultsSchema,
    {
      swarm: r.swarm,
      counts: { settled: r.counts.settled, pending: r.counts.pending, in_verification: r.counts.inVerification, rejected: r.counts.rejected, impact_settled: r.counts.impactSettled },
      items: r.items.map(toPublicResult),
    },
    { headers: { 'cache-control': PUBLIC_CACHE } },
  );
}
