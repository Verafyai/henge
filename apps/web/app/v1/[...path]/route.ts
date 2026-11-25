import { apiError } from '@/lib/api';
import { matchPlanned } from '@/lib/api-plan';

export const dynamic = 'force-dynamic';

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = `/${(await params).path.join('/')}`;
  const planned = matchPlanned(req.method, path);
  if (planned) return apiError(501, 'not_implemented', `${req.method} ${planned.path} arrives in milestone ${planned.milestone}.`);
  return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
