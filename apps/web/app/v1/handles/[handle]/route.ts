import { communityHandler } from '@/lib/community/route-file';

export const dynamic = 'force-dynamic';

export const GET = communityHandler('/handles', 'handle');
