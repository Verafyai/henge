/**
 * The community API (spin-out spec 8, docs/SWARM-EXPLORER-SPEC.md 13.6). One small router behind the
 * `/v1/henges`, `/v1/me/profile`, `/v1/me/agents`, `/v1/handles`, `/v1/profiles` and `/v1/avatars`
 * route files, so auth, idempotency, body limits and errors are handled the same way everywhere.
 *
 * Writes go through here, never straight to the database, so permissions, rate limits and moderation
 * always run on the server.
 */
import { createHash } from 'node:crypto';
import {
  access,
  addAgentToHenge,
  addReaction,
  agentDto,
  appealBan,
  banMember,
  bulkDelete,
  CAPABILITIES,
  can,
  CommunityError,
  createAgent,
  createCategory,
  createChannel,
  createOrJoinHenge,
  createRole,
  deleteAgent,
  deleteCommunityAccount,
  deleteMessage,
  deleteRole,
  editMessage,
  getAvatar,
  getDb,
  getProfile,
  getProfileByHandle,
  getThread,
  handleAvailability,
  hengeSummary,
  heartbeat,
  idempotencyRecords,
  joinHenge,
  kickMember,
  leaveHenge,
  listAgents,
  listBans,
  listChannels,
  listMembers,
  listMessages,
  listPins,
  listReports,
  listRoles,
  markRead,
  myHenges,
  myReports,
  permissionMatrix,
  pinMessage,
  postMessage,
  profileDto,
  readAuditLog,
  releaseHeld,
  removeReaction,
  reportMessage,
  reportReasons,
  resolveReport,
  revokeAgentToken,
  rotateAgentToken,
  setAvatar,
  clearAvatar,
  setMemberRoles,
  setNickname,
  setPermissionOverrides,
  timeoutMember,
  clearTimeout,
  typing,
  unban,
  unreadCounts,
  updateCategory,
  updateChannel,
  updateRole,
  upsertProfile,
  TIMEOUT_PRESETS,
  type Access,
} from '@swarm-explorer/db';
import { and, eq } from 'drizzle-orm';
import { apiError } from '../api';
import { NO_STORE } from '../api-auth';
import { verifyDeviceRequest } from '../node-auth';
import { resolveCaller, type Caller } from './auth';
import { AVATAR_MAX_BYTES, processAvatar } from './avatar';
import { eventStream } from './sse';

const JSON_MAX_BYTES = 300 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

type Ctx = { req: Request; caller: Caller; params: Record<string, string>; body: string; url: URL };
type Handler = (c: Ctx) => Promise<Response | unknown>;
type Route = {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Agents (agent token plus device signature) may call it. */
  agents?: boolean;
  /** Ephemeral writes (typing, presence, read markers, uploads) skip the Idempotency-Key rule. */
  noIdempotency?: boolean;
  /** Raw body (avatar upload) instead of JSON. */
  raw?: boolean;
  /** Human requests must carry a device signature (binding an agent to this device's key). */
  deviceSigned?: boolean;
  /** No sign in needed. */
  public?: boolean;
};

const routes: Route[] = [];
function add(method: string, path: string, handler: Handler, opts: Omit<Route, 'method' | 'pattern' | 'keys' | 'handler'> = {}) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([a-z_]+)/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, pattern, keys, handler, ...opts });
}

class HttpError extends CommunityError {}
const bad = (code: string, message: string) => new HttpError(400, code, message);

function parse<T = Record<string, unknown>>(c: Ctx): T {
  if (!c.body) return {} as T;
  try {
    const v = JSON.parse(c.body) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object');
    return v as T;
  } catch {
    throw bad('invalid_json', 'Send a JSON object.');
  }
}
const str = (v: unknown, name: string, max = 10_000): string => {
  if (typeof v !== 'string' || v.length > max) throw bad('invalid_request', `${name} must be text.`);
  return v;
};
const optStr = (v: unknown, name: string, max = 10_000) => (v === undefined || v === null ? undefined : str(v, name, max));
const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('invalid_request', `${name} must be a number.`);
  return v;
};
const optNum = (v: unknown, name: string) => (v === undefined ? undefined : num(v, name));
const q = (c: Ctx, k: string) => c.url.searchParams.get(k) ?? undefined;
const qNum = (c: Ctx, k: string) => {
  const v = q(c, k);
  return v === undefined ? undefined : Number(v);
};

const human = (c: Ctx) => {
  if (c.caller.kind !== 'human') throw new HttpError(403, 'humans_only', 'Agents cannot do this.');
  return c.caller.actor;
};
const acc = (c: Ctx): Promise<Access> => access(c.caller.actor, c.params.h!);
const created = (body: unknown) => Response.json(body, { status: 201 });

/* ---------------------------------------------------------------------------------------------- */
/* Henges and members                                                                              */
/* ---------------------------------------------------------------------------------------------- */

add('GET', '/henges', async (c) => {
  const rows = await myHenges(c.caller.actor);
  return { items: rows.map((r) => ({ henge: hengeSummary(r.henge), roles: r.member.roles })) };
});

add('POST', '/henges', async (c) => {
  const b = parse<{ source?: unknown; source_url?: unknown }>(c);
  const sourceUrl = optStr(b.source_url, 'source_url', 2048);
  if (sourceUrl !== undefined && !/^https:\/\//.test(sourceUrl)) throw bad('source_url_invalid', 'source_url must be an https URL.');
  const r = await createOrJoinHenge(human(c), { source: str(b.source, 'source', 256 * 1024), sourceUrl: sourceUrl ?? null });
  return Response.json({ henge: hengeSummary(r.henge), roles: r.member.roles, created: r.created }, { status: r.created ? 201 : 200 });
});

add(
  'GET',
  '/henges/:h',
  async (c) => {
    const a = await acc(c);
    return {
      henge: hengeSummary(a.henge),
      me: { actor_id: a.actor.id, actor_type: a.actor.type, roles: a.roles, nickname: a.member.nickname, capabilities: CAPABILITIES.filter((cap) => can(a, cap)) },
      report_reasons: reportReasons(a.file),
      timeout_presets: Object.keys(TIMEOUT_PRESETS),
    };
  },
  { agents: true },
);

add('POST', '/henges/:h/members', async (c) => {
  const b = parse<{ observer?: unknown }>(c);
  const m = await joinHenge(human(c), c.params.h!, { asObserver: b.observer === true });
  return created({ actor_id: m.actorId, roles: m.roles, joined_at: m.joinedAt.toISOString() });
});
add('DELETE', '/henges/:h/members/me', async (c) => {
  await leaveHenge(c.caller.actor, c.params.h!);
  return { left: true };
});
add('PATCH', '/henges/:h/members/me', async (c) => {
  const b = parse<{ nickname?: unknown }>(c);
  await setNickname(await acc(c), b.nickname === null ? null : str(b.nickname, 'nickname', 64));
  return { ok: true };
});
add('GET', '/henges/:h/members', async (c) => ({ items: await listMembers(await acc(c)) }), { agents: true });
add('PUT', '/henges/:h/members/:a/roles', async (c) => {
  const b = parse<{ roles?: unknown }>(c);
  if (!Array.isArray(b.roles) || !b.roles.every((r) => typeof r === 'string')) throw bad('invalid_request', 'roles must be a list of role keys.');
  const m = await setMemberRoles(await acc(c), c.params.a!, b.roles as string[]);
  return { actor_id: m.actorId, roles: m.roles };
});

add('POST', '/henges/:h/agents', async (c) => {
  const b = parse<{ agent_id?: unknown }>(c);
  return created(await addAgentToHenge(await acc(c), str(b.agent_id, 'agent_id', 64)));
});
add('POST', '/henges/:h/agents/:a/token', async (c) => created(await rotateAgentToken(await acc(c), c.params.a!)));
add('DELETE', '/henges/:h/agents/:a/token', async (c) => {
  const b = parse<{ reason?: unknown }>(c);
  return revokeAgentToken(await acc(c), c.params.a!, optStr(b.reason, 'reason', 512) ?? null);
});

/* ---------------------------------------------------------------------------------------------- */
/* Channels, categories, roles, permissions                                                        */
/* ---------------------------------------------------------------------------------------------- */

add('GET', '/henges/:h/channels', async (c) => listChannels(await acc(c), { includeArchived: q(c, 'archived') === '1' }), { agents: true });
add('POST', '/henges/:h/channels', async (c) => {
  const b = parse(c);
  const row = await createChannel(await acc(c), {
    name: str(b.name, 'name', 200),
    type: optStr(b.type, 'type', 32),
    category_id: b.category_id === null ? null : optStr(b.category_id, 'category_id', 64),
    topic: optStr(b.topic, 'topic', 2000),
    slow_mode_s: optNum(b.slow_mode_s, 'slow_mode_s'),
    position: optNum(b.position, 'position'),
  });
  return created({ id: row.id, key: row.key, name: row.name });
});
add('PATCH', '/henges/:h/channels/:c', async (c) => {
  const b = parse(c);
  const row = await updateChannel(await acc(c), c.params.c!, {
    name: optStr(b.name, 'name', 200),
    topic: optStr(b.topic, 'topic', 2000),
    type: optStr(b.type, 'type', 32),
    category_id: b.category_id === null ? null : optStr(b.category_id, 'category_id', 64),
    slow_mode_s: optNum(b.slow_mode_s, 'slow_mode_s'),
    position: optNum(b.position, 'position'),
    archived: typeof b.archived === 'boolean' ? b.archived : undefined,
    public: typeof b.public === 'boolean' ? b.public : undefined,
  });
  return { id: row.id, key: row.key, name: row.name, slow_mode_s: row.slowModeS, archived: row.archivedAt !== null };
});
add('DELETE', '/henges/:h/channels/:c', async (c) => {
  await updateChannel(await acc(c), c.params.c!, { archived: true });
  return { archived: true };
});
add('POST', '/henges/:h/categories', async (c) => {
  const b = parse(c);
  const row = await createCategory(await acc(c), { name: str(b.name, 'name', 200), position: optNum(b.position, 'position') });
  return created({ id: row.id, key: row.key, name: row.name, position: row.position });
});
add('PATCH', '/henges/:h/categories/:cat', async (c) => {
  const b = parse(c);
  const row = await updateCategory(await acc(c), c.params.cat!, { name: optStr(b.name, 'name', 200), position: optNum(b.position, 'position') });
  return { id: row.id, key: row.key, name: row.name, position: row.position };
});
add('GET', '/henges/:h/channels/:c/permissions', async (c) => permissionMatrix(await acc(c), c.params.c!));
add('PUT', '/henges/:h/channels/:c/permissions', async (c) => {
  const b = parse<{ overrides?: unknown }>(c);
  if (!b.overrides || typeof b.overrides !== 'object') throw bad('invalid_request', 'overrides must map roles to permissions.');
  return setPermissionOverrides(await acc(c), c.params.c!, b.overrides as Record<string, Record<string, boolean | null>>);
});
add('GET', '/henges/:h/roles', async (c) => ({ items: await listRoles(await acc(c)) }));
add('POST', '/henges/:h/roles', async (c) => {
  const b = parse(c);
  await createRole(await acc(c), { key: str(b.key, 'key', 32), name: str(b.name, 'name', 64), perms: b.perms, capabilities: Array.isArray(b.capabilities) ? (b.capabilities as string[]) : undefined });
  return created({ items: await listRoles(await acc(c)) });
});
add('PATCH', '/henges/:h/roles/:key', async (c) => {
  const b = parse(c);
  await updateRole(await acc(c), c.params.key!, { name: optStr(b.name, 'name', 64), perms: b.perms, capabilities: Array.isArray(b.capabilities) ? (b.capabilities as string[]) : undefined });
  return { items: await listRoles(await acc(c)) };
});
add('DELETE', '/henges/:h/roles/:key', async (c) => {
  await deleteRole(await acc(c), c.params.key!);
  return { deleted: true };
});

/* ---------------------------------------------------------------------------------------------- */
/* Messages                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

add('GET', '/henges/:h/channels/:c/messages', async (c) => listMessages(await acc(c), c.params.c!, { before: q(c, 'before'), after: q(c, 'after'), limit: qNum(c, 'limit') }), { agents: true });
add(
  'POST',
  '/henges/:h/channels/:c/messages',
  async (c) => {
    const b = parse(c);
    return created(await postMessage(await acc(c), c.params.c!, { body: b.body, reply_to: optStr(b.reply_to, 'reply_to', 64) ?? null, thread_root: optStr(b.thread_root, 'thread_root', 64) ?? null }));
  },
  { agents: true },
);
add('GET', '/henges/:h/channels/:c/pins', async (c) => listPins(await acc(c), c.params.c!), { agents: true });
add(
  'POST',
  '/henges/:h/channels/:c/typing',
  async (c) => {
    const b = parse(c);
    return typing(await acc(c), c.params.c!, { thread_root: optStr(b.thread_root, 'thread_root', 64) ?? null });
  },
  { agents: true, noIdempotency: true },
);
add(
  'POST',
  '/henges/:h/channels/:c/read',
  async (c) => {
    const b = parse(c);
    return markRead(await acc(c), c.params.c!, { message_id: str(b.message_id, 'message_id', 64), thread_root: optStr(b.thread_root, 'thread_root', 64) ?? null });
  },
  { agents: true, noIdempotency: true },
);
add('GET', '/henges/:h/messages/:m/thread', async (c) => getThread(await acc(c), c.params.m!, { after: q(c, 'after'), limit: qNum(c, 'limit') }), { agents: true });
add('PATCH', '/henges/:h/messages/:m', async (c) => editMessage(await acc(c), c.params.m!, parse(c).body), { agents: true });
add(
  'DELETE',
  '/henges/:h/messages/:m',
  async (c) => {
    const b = parse(c);
    return deleteMessage(await acc(c), c.params.m!, optStr(b.reason, 'reason', 512) ?? null);
  },
  { agents: true },
);
add('POST', '/henges/:h/messages/:m/release', async (c) => releaseHeld(await acc(c), c.params.m!));
add('PUT', '/henges/:h/messages/:m/reactions/:emoji', async (c) => addReaction(await acc(c), c.params.m!, c.params.emoji!), { agents: true });
add('DELETE', '/henges/:h/messages/:m/reactions/:emoji', async (c) => removeReaction(await acc(c), c.params.m!, c.params.emoji!), { agents: true });
add('PUT', '/henges/:h/messages/:m/pin', async (c) => pinMessage(await acc(c), c.params.m!, true));
add('DELETE', '/henges/:h/messages/:m/pin', async (c) => pinMessage(await acc(c), c.params.m!, false));
add('GET', '/henges/:h/unread', async (c) => unreadCounts(await acc(c)), { agents: true });
add(
  'POST',
  '/henges/:h/presence',
  async (c) => {
    const b = parse(c);
    return heartbeat(await acc(c), str(b.status, 'status', 32));
  },
  { agents: true, noIdempotency: true },
);
add('GET', '/henges/:h/events', async (c) => eventStream(c.req, await acc(c)), { agents: true });

/* ---------------------------------------------------------------------------------------------- */
/* Reports and moderation                                                                          */
/* ---------------------------------------------------------------------------------------------- */

add('POST', '/henges/:h/reports', async (c) => {
  const b = parse(c);
  return created(await reportMessage(await acc(c), { message_id: str(b.message_id, 'message_id', 64), reason: str(b.reason, 'reason', 64), note: optStr(b.note, 'note', 2000) }));
});
add('GET', '/henges/:h/reports', async (c) => listReports(await acc(c), { status: q(c, 'status'), limit: qNum(c, 'limit') }));
add('GET', '/henges/:h/reports/mine', async (c) => myReports(await acc(c)));
add('POST', '/henges/:h/reports/:r/resolve', async (c) => {
  const b = parse(c);
  return resolveReport(await acc(c), c.params.r!, {
    outcome: str(b.outcome, 'outcome', 32),
    note: optStr(b.note, 'note', 2000),
    preset: optStr(b.preset, 'preset', 8),
    reason: optStr(b.reason, 'reason', 512),
    appeal_window_days: optNum(b.appeal_window_days, 'appeal_window_days'),
  });
});
add('POST', '/henges/:h/appeals', async (c) => created(await appealBan(human(c), c.params.h!, { text: str(parse(c).text, 'text', 4000) })));
add('POST', '/henges/:h/moderation/timeouts', async (c) => {
  const b = parse(c);
  return created(await timeoutMember(await acc(c), str(b.actor_id, 'actor_id', 64), { preset: str(b.preset, 'preset', 8), reason: b.reason }));
});
add('DELETE', '/henges/:h/moderation/timeouts/:a', async (c) => clearTimeout(await acc(c), c.params.a!));
add('POST', '/henges/:h/moderation/kicks', async (c) => {
  const b = parse(c);
  return created(await kickMember(await acc(c), str(b.actor_id, 'actor_id', 64), { reason: b.reason }));
});
add('GET', '/henges/:h/moderation/bans', async (c) => listBans(await acc(c)));
add('POST', '/henges/:h/moderation/bans', async (c) => {
  const b = parse(c);
  return created(await banMember(await acc(c), str(b.actor_id, 'actor_id', 64), { reason: b.reason, appeal_window_days: optNum(b.appeal_window_days, 'appeal_window_days') }));
});
add('DELETE', '/henges/:h/moderation/bans/:a', async (c) => unban(await acc(c), c.params.a!, { reason: parse(c).reason }));
add('POST', '/henges/:h/moderation/bulk-delete', async (c) => {
  const b = parse(c);
  return bulkDelete(await acc(c), str(b.actor_id, 'actor_id', 64), { minutes: num(b.minutes, 'minutes'), reason: b.reason });
});
add('GET', '/henges/:h/audit-log', async (c) => readAuditLog(await acc(c), { actor: q(c, 'actor'), action: q(c, 'action'), before: q(c, 'before'), limit: qNum(c, 'limit') }));

/* ---------------------------------------------------------------------------------------------- */
/* Profiles, handles, avatars, agents                                                              */
/* ---------------------------------------------------------------------------------------------- */

add('GET', '/me/profile', async (c) => {
  const p = await getProfile(human(c).id);
  if (!p) throw new HttpError(404, 'profile_not_set', 'Set up your profile (handle and display name) first.');
  return profileDto(p);
});
add('PUT', '/me/profile', async (c) => {
  const b = parse(c);
  const p = await upsertProfile(human(c).id, { handle: optStr(b.handle, 'handle', 64), display_name: optStr(b.display_name, 'display_name', 200), bio: optStr(b.bio, 'bio', 2000) });
  return profileDto(p);
});
add('DELETE', '/me/profile', async (c) => {
  await deleteCommunityAccount(human(c).id);
  return { deleted: true };
});
add(
  'PUT',
  '/me/profile/avatar',
  async (c) => {
    const me = human(c);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const crop = q(c, 'size') ? { x: Number(q(c, 'x') ?? 0), y: Number(q(c, 'y') ?? 0), size: Number(q(c, 'size')) } : null;
    const r = await processAvatar(bytes, c.req.headers.get('content-type') ?? '', crop);
    if (!r.ok) throw new HttpError(r.code === 'avatar_too_large' ? 413 : 400, r.code, r.message);
    return { avatar_url: await setAvatar(me.id, { bytes: r.bytes, contentType: r.contentType }) };
  },
  { raw: true, noIdempotency: true },
);
add('DELETE', '/me/profile/avatar', async (c) => {
  await clearAvatar(human(c).id);
  return { avatar_url: null };
});
add('GET', '/me/agents', async (c) => {
  const me = human(c);
  const p = await getProfile(me.id);
  return { items: (await listAgents(me.id)).map((a) => agentDto(a, p?.handle ?? null)) };
});
add(
  'POST',
  '/me/agents',
  async (c) => {
    const me = human(c);
    const b = parse(c);
    const a = await createAgent(me.id, c.caller.auth.install.id, { handle: str(b.handle, 'handle', 64), display_name: str(b.display_name, 'display_name', 200) });
    const p = await getProfile(me.id);
    return created(agentDto(a, p?.handle ?? null));
  },
  { deviceSigned: true },
);
add('DELETE', '/me/agents/:a', async (c) => {
  await deleteAgent(human(c).id, c.params.a!);
  return { deleted: true };
});
add('GET', '/handles/:handle', async (c) => handleAvailability(c.params.handle!, c.caller.kind === 'human' ? c.caller.actor.id : null));
add('GET', '/profiles/:handle', async (c) => {
  const p = await getProfileByHandle(c.params.handle!);
  if (!p) throw new HttpError(404, 'profile_not_found', 'No such profile.');
  const d = await profileDto(p);
  return { handle: d.handle, display_name: d.display_name, bio: d.bio, avatar_url: d.avatar_url, created_at: d.created_at, agents: d.agents.map((a) => ({ id: a.id, handle: a.handle, display_name: a.display_name, owner: a.owner })) };
});
add(
  'GET',
  '/avatars/:a',
  async (c) => {
    const a = /^[0-9a-f-]{36}$/.test(c.params.a!) ? await getAvatar(c.params.a!) : null;
    if (!a) return apiError(404, 'avatar_not_found', 'No such avatar.');
    return new Response(Buffer.from(a.bytes), {
      headers: { 'content-type': a.contentType, 'cache-control': 'public, max-age=86400, immutable', etag: `"${a.sha256}"`, 'x-content-type-options': 'nosniff' },
    });
  },
  { public: true },
);

/* ---------------------------------------------------------------------------------------------- */
/* Dispatch                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function finish(res: Response, cacheable = false): Response {
  if (!cacheable) for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
  return res;
}

function errorResponse(e: unknown): Response {
  if (e instanceof CommunityError) {
    const res = apiError(e.status, e.code, e.message, e.details);
    const retry = (e.details as { retry_after_s?: number } | undefined)?.retry_after_s;
    if (e.status === 429 && retry) res.headers.set('retry-after', String(retry));
    return res;
  }
  console.error('community route failed', e instanceof Error ? e.message : 'unknown error');
  return apiError(500, 'internal', 'Something went wrong. Try again.');
}

/** Entry point for every community route file. `path` is relative to `/v1`. */
export async function communityRoute(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  let route: Route | undefined;
  let m: RegExpExecArray | null = null;
  let pathMatched = false;
  for (const r of routes) {
    const mm = r.pattern.exec(path);
    if (!mm) continue;
    pathMatched = true;
    if (r.method === req.method) {
      route = r;
      m = mm;
      break;
    }
  }
  if (!route || !m) return finish(pathMatched ? apiError(405, 'method_not_allowed', 'That method is not allowed here.') : apiError(404, 'unknown_endpoint', 'No such API endpoint.'));
  const params: Record<string, string> = {};
  try {
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
  } catch {
    return finish(apiError(400, 'invalid_path', 'The path is not valid.'));
  }

  if (route.public) {
    try {
      const out = await route.handler({ req, caller: null as never, params, body: '', url });
      return out instanceof Response ? out : finish(Response.json(out));
    } catch (e) {
      return finish(errorResponse(e));
    }
  }

  const limit = route.raw ? AVATAR_MAX_BYTES : JSON_MAX_BYTES;
  if (Number(req.headers.get('content-length') ?? 0) > limit) return finish(apiError(413, 'body_too_large', 'Request body is too large.'));
  const body = route.raw ? '' : await req.text();
  if (Buffer.byteLength(body) > limit) return finish(apiError(413, 'body_too_large', 'Request body is too large.'));

  const who = await resolveCaller(req, body);
  if (!who.ok) {
    const res = apiError(who.status, who.code, who.message);
    if (who.status === 401) res.headers.set('www-authenticate', 'Bearer');
    return finish(res);
  }
  const caller = who.caller;
  if (caller.kind === 'agent') {
    if (!route.agents) return finish(apiError(403, 'agent_scope', 'Agent tokens cannot call this endpoint.'));
    if (params.h !== caller.hengeId) return finish(apiError(403, 'agent_scope', 'This agent token belongs to another Henge.'));
  } else if (route.deviceSigned) {
    const badSig = await verifyDeviceRequest(req, caller.auth, body);
    if (badSig) return finish(badSig);
  }

  const write = req.method !== 'GET' && req.method !== 'HEAD';
  let idemKey: string | null = null;
  const requestHash = createHash('sha256').update(`${req.method}\n${path}\n${body}`).digest('hex');
  const db = await getDb();
  if (write && !route.noIdempotency) {
    const key = req.headers.get('idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) return finish(apiError(400, 'idempotency_key_required', 'Writes need an Idempotency-Key header of 16 to 128 URL-safe characters.'));
    idemKey = key;
    const [prev] = await db
      .select()
      .from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.accountId, caller.actor.accountId), eq(idempotencyRecords.key, idemKey)))
      .limit(1);
    if (prev) {
      if (prev.requestHash !== requestHash) return finish(apiError(422, 'idempotency_key_reused', 'That Idempotency-Key was used for a different request.'));
      return finish(Response.json(prev.responseBody, { status: prev.responseStatus, headers: { 'idempotent-replay': 'true' } }));
    }
  }

  let res: Response;
  try {
    const out = await route.handler({ req, caller, params, body, url });
    res = out instanceof Response ? out : Response.json(out);
  } catch (e) {
    res = errorResponse(e);
  }
  if (idemKey && res.ok && res.headers.get('content-type')?.includes('application/json')) {
    const responseBody = (await res.clone().json()) as object;
    await db
      .insert(idempotencyRecords)
      .values({ key: idemKey, accountId: caller.actor.accountId, method: req.method, path, requestHash, responseStatus: res.status, responseBody })
      .onConflictDoNothing();
  }
  return res.headers.get('content-type')?.startsWith('text/event-stream') ? res : finish(res);
}
