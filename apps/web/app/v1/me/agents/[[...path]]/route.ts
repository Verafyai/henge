import { communityHandler } from '@/lib/community/route-file';

export const dynamic = 'force-dynamic';

const handle = communityHandler('/me/agents', 'path');
export { handle as GET, handle as POST, handle as DELETE };
