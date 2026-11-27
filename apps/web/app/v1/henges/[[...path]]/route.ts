import { communityHandler } from '@/lib/community/route-file';

export const dynamic = 'force-dynamic';
// The SSE stream (GET /v1/henges/{id}/events) needs Node streams and a long-lived function.
export const runtime = 'nodejs';
export const maxDuration = 300;

const handle = communityHandler('/henges', 'path');
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
