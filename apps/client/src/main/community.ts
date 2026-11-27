/**
 * The community service (spin-out spec v2, 8; `packages/api-client/src/community.ts`) as the renderer
 * reaches it. Tokens never leave main: the renderer names an allowlisted operation and its arguments,
 * main calls it with the session's bearer token and returns data or a plain error. Realtime events
 * are read here over SSE and forwarded to the window that asked for them.
 */
import { ApiError, createCommunityClient, type CommunityClient, type Subscription } from '@swarm-explorer/api-client';
import { ipcMain, type WebContents } from 'electron';
import { z } from 'zod';
import type { AuthManager } from './auth';
import type { HengeLibrary } from './henges';
import type { SecretStore } from './secrets';
import { IPC } from '../shared/bridge';
import type { CommunityCallResult, CommunityConnectResult } from '../shared/henge';

/** Person-client operations the renderer may call, with argument counts. Nothing else crosses. */
export const COMMUNITY_OPS = [
  'myHenges', 'getHenge', 'listChannels', 'listMembers', 'listMessages', 'postMessage', 'getThread', 'editMessage', 'deleteMessage',
  'addReaction', 'removeReaction', 'typing', 'presence', 'markRead', 'unread', 'listPins', 'pin', 'unpin', 'leave', 'setNickname',
  'updateChannel', 'permissions', 'setPermissions', 'listRoles', 'report', 'reports', 'myReports', 'resolveReport', 'appeal',
  'timeout', 'clearTimeout', 'kick', 'ban', 'unban', 'bans', 'bulkDelete', 'auditLog', 'revokeAgentToken', 'myProfile', 'saveProfile',
  'removeAvatar', 'handleAvailable', 'profile', 'myAgents',
] as const satisfies ReadonlyArray<keyof CommunityClient>;
export type CommunityOp = (typeof COMMUNITY_OPS)[number];

const callSchema = z.object({ op: z.enum(COMMUNITY_OPS), args: z.array(z.unknown()).max(6) });
const avatarSchema = z.object({ bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 4 * 1024 * 1024), type: z.enum(['image/png', 'image/jpeg', 'image/webp']) });
const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export function errorResult(e: unknown): Extract<CommunityCallResult, { ok: false }> {
  if (e instanceof ApiError) {
    const d = e.details as { retry_after_s?: number } | undefined;
    return { ok: false, status: e.status, code: e.code, message: e.message, ...(d?.retry_after_s ? { retryAfterS: d.retry_after_s } : {}) };
  }
  if (e instanceof Error && e.message === 'Signed out.') return { ok: false, status: 401, code: 'signed_out', message: 'Sign in to use the community.' };
  return { ok: false, status: 0, code: 'offline', message: 'The community service could not be reached.' };
}

export function registerCommunity(deps: { auth: AuthManager; apiBaseUrl: string; secrets: SecretStore; henges: () => HengeLibrary; trusted: (e: Electron.IpcMainInvokeEvent) => boolean }) {
  const { auth } = deps;
  const client = createCommunityClient({ baseUrl: deps.apiBaseUrl, getAccessToken: () => auth.getAccessToken() });
  const subs = new Map<string, { sub: Subscription; to: WebContents }>();
  const closeAll = () => {
    for (const s of subs.values()) s.sub.close();
    subs.clear();
  };
  auth.on('changed', (s) => {
    if (s.status === 'signed_out') {
      closeAll();
      void deps.secrets.delete('agent-tokens');
    }
  });

  const run = async <T>(fn: () => Promise<T>): Promise<CommunityCallResult<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return errorResult(e);
    }
  };

  ipcMain.handle(IPC.communityCall, async (e, raw: unknown): Promise<CommunityCallResult> => {
    const p = callSchema.safeParse(raw);
    if (!deps.trusted(e) || !p.success) return { ok: false, status: 400, code: 'refused', message: 'That request was refused.' };
    const fn = client[p.data.op] as (...a: unknown[]) => Promise<unknown>;
    return run(() => fn(...p.data.args));
  });

  ipcMain.handle(IPC.communityAvatar, async (e, raw: unknown): Promise<CommunityCallResult> => {
    const p = avatarSchema.safeParse(raw);
    if (!deps.trusted(e) || !p.success) return { ok: false, status: 400, code: 'refused', message: 'That image was refused.' };
    return run(() => client.uploadAvatar(p.data.bytes, p.data.type));
  });

  /** Creates this computer's agent identity (device signed, so only a signed-in Henge app can). */
  ipcMain.handle(IPC.communityCreateAgent, async (e, raw: unknown): Promise<CommunityCallResult> => {
    const p = z.object({ handle: z.string().min(3).max(64), display_name: z.string().min(1).max(64) }).safeParse(raw);
    if (!deps.trusted(e) || !p.success) return { ok: false, status: 400, code: 'refused', message: 'That request was refused.' };
    return run(async () => {
      const res = await auth.signedFetch('POST', '/v1/me/agents', p.data);
      const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
      if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `Request failed with status ${res.status}`);
      return body;
    });
  });

  /**
   * Creates or joins the Henge on the community service from the stored `.henge` file, then adds this
   * computer's agent. The agent token is returned once and kept in the OS keychain only.
   */
  ipcMain.handle(IPC.hengesConnect, async (e, raw: unknown): Promise<CommunityConnectResult> => {
    const key = z.string().regex(/^[a-z0-9-]+--[a-z0-9-]+$/).safeParse(raw);
    if (!deps.trusted(e) || !key.success) return { ok: false, status: 400, code: 'refused', message: 'That request was refused.' };
    const lib = deps.henges();
    const h = lib.get(key.data);
    const source = lib.source(key.data);
    if (!h || source === null) return { ok: false, status: 404, code: 'not_found', message: 'That Henge is not on this computer.' };
    const r = await run(async () => {
      const joined = h.communityId ? { henge: { id: h.communityId } } : await client.createOrJoin(source, h.sourceUrl?.startsWith('https://') ? h.sourceUrl : undefined);
      const saved = h.communityId ? h : lib.setCommunityId(key.data, joined.henge.id);
      const agents = await client.myAgents().catch(() => ({ items: [] }));
      const agent = agents.items[0];
      if (agent) {
        const members = await client.listMembers(joined.henge.id);
        if (!members.items.some((m) => m.actor.id === agent.id)) {
          const t = await client.addAgent(joined.henge.id, agent.id);
          const all = JSON.parse((await deps.secrets.get('agent-tokens')) ?? '{}') as Record<string, string>;
          all[`${t.henge_id}:${t.agent_id}`] = t.token;
          await deps.secrets.set('agent-tokens', JSON.stringify(all));
        }
      }
      return saved;
    });
    return r.ok ? { ok: true, henge: r.value! } : r;
  });

  ipcMain.handle(IPC.communityWatch, async (e, raw: unknown) => {
    const id = idSchema.safeParse(raw);
    if (!deps.trusted(e) || !id.success) return false;
    if (subs.has(id.data)) return true;
    const to = e.sender;
    const sub = client.events(id.data, {
      onEvent: (ev) => !to.isDestroyed() && to.send(IPC.communityEvent, ev),
      onClosed: (reason) => {
        subs.delete(id.data);
        if (!to.isDestroyed()) to.send(IPC.communityEvent, { id: '', kind: 'stream.closed', henge_id: id.data, channel_id: null, payload: { reason }, created_at: new Date().toISOString() });
      },
      onError: (_err, fatal) => {
        if (fatal) subs.delete(id.data);
      },
    });
    subs.set(id.data, { sub, to });
    to.once('destroyed', closeAll);
    return true;
  });
  ipcMain.handle(IPC.communityUnwatch, (e, raw: unknown) => {
    const id = idSchema.safeParse(raw);
    if (!deps.trusted(e) || !id.success) return false;
    subs.get(id.data)?.sub.close();
    subs.delete(id.data);
    return true;
  });
}
