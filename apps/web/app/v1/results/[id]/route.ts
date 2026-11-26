import { publicResultSchema } from '@swarm-explorer/api-client';
import { publicResult } from '@swarm-explorer/db';
import { z } from 'zod';
import { apiError, json, PUBLIC_CACHE } from '@/lib/api';
import { toPublicResult } from '@/lib/public-results';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/results/{id} (SPEC 13.3, built M7): the public view of one settled result. Anything that has
 * not settled is not public and answers 404; contributors see their own work through /v1/me/results.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError(400, 'invalid_id', 'That result id is not valid.');
  const r = await publicResult(id.data);
  if (!r) return apiError(404, 'not_found', 'No settled result has that id.');
  return json(publicResultSchema, toPublicResult(r), { headers: { 'cache-control': PUBLIC_CACHE } });
}
