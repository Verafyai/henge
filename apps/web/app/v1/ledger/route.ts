import { ledgerListSchema } from '@swarm-explorer/api-client';
import { ledgerFor } from '@swarm-explorer/db';
import { json } from '@/lib/api';
import { withBearer } from '@/lib/bearer';

export const dynamic = 'force-dynamic';

/** GET /v1/ledger (SPEC 13.4): the caller's own ledger rows, newest first. Nobody else's. */
export const GET = withBearer(async (_req, { user }) => {
  const rows = await ledgerFor(user.id);
  return json(ledgerListSchema, {
    items: rows.map(({ entry: e, bucket }) => ({
      id: e.id,
      txn_id: e.txnId,
      movement_type: e.movementType,
      bucket,
      debit: e.debitCredits,
      credit: e.creditCredits,
      reference_type: e.referenceType,
      reference_id: e.referenceId,
      created_at: e.createdAt.toISOString(),
    })),
  });
});
