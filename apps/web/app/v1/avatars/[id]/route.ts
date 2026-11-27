import { communityHandler } from '@/lib/community/route-file';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = communityHandler('/avatars', 'id');
