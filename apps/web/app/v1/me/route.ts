import { meSchema } from '@swarm-explorer/api-client';
import { can } from '@swarm-explorer/core';
import { apiError, json } from '@/lib/api';
import { withBearer } from '@/lib/bearer';

export const dynamic = 'force-dynamic';

export const GET = withBearer(async (_req, { user, install }) => {
  if (!can(user, 'account.read', { accountId: user.id })) return apiError(403, 'forbidden', 'Not allowed.');
  return json(meSchema, {
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    installId: install.id,
  });
});
