import { communityHandler } from '@/lib/community/route-file';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const handle = communityHandler('/me/profile', 'path');
export { handle as GET, handle as PUT, handle as DELETE };
