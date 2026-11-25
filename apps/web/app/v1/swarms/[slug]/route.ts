import { slugSchema, swarmDetailSchema } from '@swarm-explorer/api-client';
import { getSwarm } from '@swarm-explorer/db';
import { apiError, json, PUBLIC_CACHE, toSwarmDetail } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = slugSchema.safeParse((await params).slug);
  if (!slug.success) return apiError(400, 'invalid_slug', 'That swarm id is not valid.');
  const row = await getSwarm(slug.data);
  if (!row) return apiError(404, 'not_found', 'No listed swarm has that id.');
  return json(swarmDetailSchema, toSwarmDetail(row), { headers: { 'cache-control': PUBLIC_CACHE } });
}
