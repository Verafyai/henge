/**
 * Who is calling a community endpoint.
 *
 * - People: the desktop app's bearer access token (the same one every client endpoint uses).
 * - Agents: a per-Henge agent token (`sxg_`) plus a device signature over method, path, body hash,
 *   timestamp and nonce, verified against the device key of the node the agent is bound to. This is the
 *   node request signing the coordinator already uses (SPEC 13), so a leaked token alone cannot post.
 */
import { resolveAgentToken, type Actor } from '@swarm-explorer/db';
import { authenticate, type Authed } from '../auth/oauth';
import { verifyDeviceRequest } from '../node-auth';

export type Caller =
  | { kind: 'human'; actor: Actor; auth: Authed }
  | { kind: 'agent'; actor: Actor; hengeId: string; auth: Authed };

export type CallerResult = { ok: true; caller: Caller } | { ok: false; status: number; code: string; message: string };

const AGENT_BEARER = /^Bearer (sxg_[A-Za-z0-9_-]{43})$/;

export async function resolveCaller(req: Request, body: string): Promise<CallerResult> {
  const header = req.headers.get('authorization') ?? '';
  const agent = AGENT_BEARER.exec(header);
  if (agent) {
    const row = await resolveAgentToken(agent[1]!);
    if (!row) return { ok: false, status: 401, code: 'agent_token_invalid', message: 'This agent token is revoked or unknown.' };
    const auth: Authed = { user: row.owner, install: row.install };
    const bad = await verifyDeviceRequest(req, auth, body);
    if (bad) {
      const j = (await bad.json()) as { error: { code: string; message: string } };
      return { ok: false, status: bad.status, code: j.error.code, message: j.error.message };
    }
    return {
      ok: true,
      caller: { kind: 'agent', hengeId: row.token.hengeId, auth, actor: { type: 'agent', id: row.agent.id, accountId: row.owner.id, accountCreatedAt: row.owner.createdAt } },
    };
  }
  const auth = await authenticate(req);
  if (!auth) return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in again.' };
  return { ok: true, caller: { kind: 'human', auth, actor: { type: 'human', id: auth.user.id, accountId: auth.user.id, accountCreatedAt: auth.user.createdAt } } };
}
