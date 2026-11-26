import { apiError } from '@/lib/api';
import { matchPlanned } from '@/lib/api-plan';
import { postTaskBatch } from '@/lib/task-batch';

export const dynamic = 'force-dynamic';

const TASK_BATCH = /^\/swarms\/([^/]+)\/tasks:batch$/;

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = `/${(await params).path.join('/')}`;
  const batch = req.method === 'POST' ? TASK_BATCH.exec(path) : null;
  if (batch) return postTaskBatch(decodeURIComponent(batch[1]!))(req, undefined);
  const planned = matchPlanned(req.method, path);
  if (planned) return apiError(501, 'not_implemented', `${req.method} ${planned.path} arrives in milestone ${planned.milestone}.`);
  return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
