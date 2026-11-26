import { getDb, accounts } from '@swarm-explorer/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { apiError } from '@/lib/api';
import { formBody } from '@/lib/api-auth';
import { createSession, devSignInEnabled, safeNext, sameOrigin } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ handle: z.string().min(1).max(64), next: z.string().max(2048).optional() });

/** Development only: sign in as a seeded example user. 404 when disabled. */
export async function POST(req: Request) {
  if (!devSignInEnabled()) return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
  if (!sameOrigin(req)) return apiError(403, 'cross_origin', 'This form must be submitted from Henge web.');
  const parsed = bodySchema.safeParse(await formBody(req));
  if (!parsed.success) return apiError(400, 'invalid_request', 'Pick an example user.');
  const db = await getDb();
  const [user] = await db.select().from(accounts).where(sql`lower(${accounts.handle}) = lower(${parsed.data.handle})`).limit(1);
  if (!user) return apiError(404, 'not_found', 'No such example user.');
  await createSession(user.id);
  return new Response(null, { status: 303, headers: { location: safeNext(parsed.data.next) } });
}
