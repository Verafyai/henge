import { setVerificationRule } from '@swarm-explorer/db';
import { z } from 'zod';
import { apiError } from '@/lib/api';
import { devSignInEnabled } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ swarm: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), review_window_s: z.number().int().min(0).max(3600).nullable() }).strict();

/**
 * Development and tests only: stores a new verification rule version with a short test review
 * window, so e2e can watch pending work settle. Not an approved value. 404 when disabled; the custom
 * header forces a CORS preflight, so a web page cannot call it.
 */
export async function POST(req: Request) {
  if (!devSignInEnabled()) return apiError(404, 'unknown_endpoint', 'No such API endpoint.');
  if (req.headers.get('x-dev-tool') !== '1') return apiError(403, 'forbidden', 'Development tool only.');
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(400, 'invalid_body', 'Send swarm and review_window_s.');
  try {
    const r = await setVerificationRule({ swarmSlug: parsed.data.swarm, reviewWindowS: parsed.data.review_window_s, notes: 'Development tool: test review window, not an approved value.' });
    return Response.json({ swarm: parsed.data.swarm, version: r.version, review_window_s: r.reviewWindowS });
  } catch {
    return apiError(404, 'not_found', 'No such swarm.');
  }
}
