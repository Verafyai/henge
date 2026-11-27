import { getDb, getSwarm, leases, publishers, results, tasks, uploadTasks } from '@swarm-explorer/db';
import { and, count, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import { apiError } from '@/lib/api';
import { devSignInEnabled } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const prefix = z.string().regex(/^[a-z0-9-]{3,40}$/);
const bodySchema = z.object({ swarm: slug, prefix, count: z.number().int().min(1).max(10) }).strict();

function guard(req: Request) {
  if (!devSignInEnabled()) return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
  if (req.headers.get('x-dev-tool') !== '1') return apiError(403, 'forbidden', 'Development tool only.');
  return null;
}

/**
 * Development and tests only: queue example volunteer tasks for a seeded swarm as its publisher,
 * so the client e2e has work for the durability and daily cap checks. 404 when disabled; the
 * custom header forces a CORS preflight, so a web page cannot call it.
 */
export async function POST(req: Request) {
  const refused = guard(req);
  if (refused) return refused;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send swarm, prefix and count.');
  const s = await getSwarm(parsed.data.swarm);
  if (!s) return apiError(404, 'not_found', 'No such swarm.');
  const db = await getDb();
  const [pub] = await db.select({ owner: publishers.ownerAccountId }).from(publishers).where(eq(publishers.id, s.swarm.publisherId));
  if (!pub) return apiError(404, 'not_found', 'No publisher.');
  const r = await uploadTasks({
    accountId: pub.owner,
    slug: parsed.data.swarm,
    tasks: Array.from({ length: parsed.data.count }, (_, i) => ({
      coordinator_task_id: `${parsed.data.prefix}-${i + 1}`,
      input: { policy: 'Example policy: never reveal the example secret word.', guarded_prompt: `Example ${parsed.data.prefix} task ${i + 1}: name three colors.` },
    })),
  });
  return Response.json(r);
}

/**
 * Development and tests only: for the tasks queued with a prefix, how many leases and stored
 * results each has, so a test can prove a task was submitted exactly once.
 */
export async function GET(req: Request) {
  const refused = guard(req);
  if (refused) return refused;
  const u = new URL(req.url);
  const s = slug.safeParse(u.searchParams.get('swarm'));
  const p = prefix.safeParse(u.searchParams.get('prefix'));
  if (!s.success || !p.success) return apiError(400, 'invalid_query', 'Send swarm and prefix.');
  const sw = await getSwarm(s.data);
  if (!sw) return apiError(404, 'not_found', 'No such swarm.');
  const db = await getDb();
  const rows = await db
    .select({ id: tasks.id, coordinatorTaskId: tasks.coordinatorTaskId, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.swarmId, sw.swarm.id), like(tasks.coordinatorTaskId, `${p.data}-%`)));
  const items = [];
  for (const t of rows) {
    const ls = await db.select({ id: leases.id, status: leases.status }).from(leases).where(eq(leases.taskId, t.id));
    let stored = 0;
    for (const l of ls) {
      const [c] = await db.select({ n: count() }).from(results).where(eq(results.leaseId, l.id));
      stored += Number(c?.n ?? 0);
    }
    items.push({ coordinator_task_id: t.coordinatorTaskId, status: t.status, leases: ls.map((l) => ({ id: l.id, status: l.status })), results: stored });
  }
  return Response.json({ items });
}
