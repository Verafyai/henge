import { healthSchema } from '@swarm-explorer/api-client';
import { json } from '@/lib/api';

export const dynamic = 'force-dynamic';

export function GET() {
  return json(healthSchema, { ok: true, version: 'v1' }, { headers: { 'cache-control': 'no-store' } });
}
