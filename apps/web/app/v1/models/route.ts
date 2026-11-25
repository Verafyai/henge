import { modelListSchema } from '@swarm-explorer/api-client';
import { listModels } from '@swarm-explorer/db';
import { json, PUBLIC_CACHE, toModel } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  return json(modelListSchema, { items: (await listModels()).map(toModel) }, { headers: { 'cache-control': PUBLIC_CACHE } });
}
