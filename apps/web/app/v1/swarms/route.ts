import { listSwarmsQuerySchema, swarmListSchema } from '@swarm-explorer/api-client';
import { listSwarms } from '@swarm-explorer/db';
import { apiError, json, PUBLIC_CACHE, toSwarmSummary } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const q = listSwarmsQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return apiError(400, 'invalid_query', 'Unknown category.', { issues: q.error.issues.map((i) => i.message) });
  const rows = await listSwarms({ category: q.data.category });
  return json(swarmListSchema, { items: rows.map(toSwarmSummary) }, { headers: { 'cache-control': PUBLIC_CACHE } });
}
