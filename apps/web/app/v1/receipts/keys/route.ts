import { receiptKeysSchema } from '@swarm-explorer/api-client';
import { listPlatformKeys } from '@swarm-explorer/db';
import { json } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/receipts/keys (M7): the public keys that sign contribution receipts, so anyone can check a
 * receipt offline (`swarm receipt verify --keys <file>`). Revoked keys stay listed with their status.
 */
export async function GET() {
  return json(receiptKeysSchema, { keys: await listPlatformKeys('receipt') }, { headers: { 'cache-control': 'no-store' } });
}
