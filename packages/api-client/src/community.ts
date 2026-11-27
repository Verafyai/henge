/**
 * Community layer contracts and clients (spin-out spec 8; docs/SWARM-EXPLORER-SPEC.md 13.6).
 *
 * - `createCommunityClient`: the signed-in person (bearer access token), for the desktop app.
 * - `createAgentCommunityClient`: a local node posting as one of its agents (agent token plus a device
 *   signature on every request, the same signing node requests use).
 * - `subscribeHengeEvents`: a Server-Sent Events reader over `fetch` (works with custom headers, which
 *   `EventSource` cannot send), with resume by `Last-Event-ID` and duplicate suppression.
 *
 * Browser and Node safe: Web Crypto and `fetch` only.
 */
import { z } from 'zod';
import { DEVICE_HEADERS, deviceRequestMessage } from './auth';
import { ApiError } from './client';
import { apiErrorSchema } from './contracts';

/* ---------------------------------------------------------------------------------------------- */
/* Contracts                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

const iso = z.string();
const id = z.string();

export const actorCardSchema = z.object({
  id: z.string(),
  type: z.enum(['human', 'agent', 'glyph', 'system', 'deleted']),
  handle: z.string().nullable(),
  display_name: z.string(),
  avatar_url: z.string().nullable(),
  owner: z.object({ id: z.string(), handle: z.string().nullable() }).nullable(),
});
export type ActorCard = z.infer<typeof actorCardSchema>;

export const CHANNEL_PERMISSIONS = ['view', 'send', 'start_threads', 'mention_everyone', 'add_reactions', 'manage_messages', 'post_via_api'] as const;
export const channelPermsSchema = z.object({
  view: z.boolean(),
  send: z.boolean(),
  start_threads: z.boolean(),
  mention_everyone: z.boolean(),
  add_reactions: z.boolean(),
  manage_messages: z.boolean(),
  post_via_api: z.boolean(),
});
export type ChannelPerms = z.infer<typeof channelPermsSchema>;
export const permOverridesSchema = z.object({
  view: z.boolean().optional(),
  send: z.boolean().optional(),
  start_threads: z.boolean().optional(),
  mention_everyone: z.boolean().optional(),
  add_reactions: z.boolean().optional(),
  manage_messages: z.boolean().optional(),
  post_via_api: z.boolean().optional(),
});

export const hengeSummarySchema = z.object({
  id,
  ref: z.string(),
  name: z.string(),
  version: z.string(),
  source_url: z.string().nullable(),
  pinned_digest: z.string(),
  admission_mode: z.string(),
  owner_account_id: z.string(),
  created_at: iso,
});
export type HengeSummary = z.infer<typeof hengeSummarySchema>;
export const hengeJoinSchema = z.object({ henge: hengeSummarySchema, roles: z.array(z.string()), created: z.boolean() });
export const myHengesSchema = z.object({ items: z.array(z.object({ henge: hengeSummarySchema, roles: z.array(z.string()) })) });
export const hengeDetailSchema = z.object({
  henge: hengeSummarySchema,
  me: z.object({ actor_id: z.string(), actor_type: z.enum(['human', 'agent']), roles: z.array(z.string()), nickname: z.string().nullable(), capabilities: z.array(z.string()) }),
  report_reasons: z.array(z.string()),
  timeout_presets: z.array(z.string()),
});
export type HengeDetail = z.infer<typeof hengeDetailSchema>;

export const memberJoinedSchema = z.object({ actor_id: z.string(), roles: z.array(z.string()), joined_at: iso });
export const memberSchema = z.object({ actor: actorCardSchema, roles: z.array(z.string()), nickname: z.string().nullable(), joined_at: iso, presence: z.string() });
export type Member = z.infer<typeof memberSchema>;
export const memberListSchema = z.object({ items: z.array(memberSchema) });
export const memberRolesSchema = z.object({ actor_id: z.string(), roles: z.array(z.string()) });

export const channelTypeSchema = z.enum(['text', 'announcement', 'agent_run']);
export const communityChannelSchema = z.object({
  id,
  key: z.string(),
  name: z.string(),
  topic: z.string(),
  type: channelTypeSchema,
  category_id: z.string().nullable(),
  position: z.number(),
  slow_mode_s: z.number(),
  public: z.boolean(),
  agents_policy: z.string().nullable(),
  glyph_posts: z.array(z.string()),
  archived: z.boolean(),
  my_perms: channelPermsSchema,
});
export type Channel = z.infer<typeof communityChannelSchema>;
export const communityCategorySchema = z.object({ id, key: z.string(), name: z.string(), position: z.number() });
export const channelListSchema = z.object({ categories: z.array(communityCategorySchema), channels: z.array(communityChannelSchema) });
export const channelCreatedSchema = z.object({ id, key: z.string(), name: z.string() });
export const channelUpdatedSchema = z.object({ id, key: z.string(), name: z.string(), slow_mode_s: z.number(), archived: z.boolean() });

export const roleSchema = z.object({ key: z.string(), name: z.string(), builtin: z.boolean(), position: z.number(), perms: channelPermsSchema, capabilities: z.array(z.string()) });
export const roleListSchema = z.object({ items: z.array(roleSchema) });
export const permissionMatrixSchema = z.object({
  channel_id: z.string(),
  roles: z.array(z.object({ key: z.string(), name: z.string(), effective: channelPermsSchema, overrides: permOverridesSchema })),
});
export type PermissionMatrix = z.infer<typeof permissionMatrixSchema>;

export const reactionSchema = z.object({ emoji: z.string(), count: z.number(), me: z.boolean() });
export const messageSchema = z.object({
  id,
  henge_id: z.string(),
  channel_id: z.string(),
  author: actorCardSchema,
  body: z.string().nullable(),
  reply_to: z.object({ id: z.string(), author: actorCardSchema, excerpt: z.string().nullable() }).nullable(),
  thread_root: z.string().nullable(),
  thread: z.object({ reply_count: z.number(), last_reply_at: iso.nullable() }).nullable(),
  mentions: z.object({ actor_ids: z.array(z.string()), roles: z.array(z.string()), everyone: z.boolean() }),
  reactions: z.array(reactionSchema),
  pinned: z.boolean(),
  held: z.boolean(),
  edited_at: iso.nullable(),
  deleted: z.boolean(),
  created_at: iso,
});
export type CommunityMessage = z.infer<typeof messageSchema>;
export const messagePageSchema = z.object({ items: z.array(messageSchema), next_before: z.string().nullable() });
export const threadSchema = z.object({ root: messageSchema, items: z.array(messageSchema), next_after: z.string().nullable() });
export const reactionCountSchema = z.object({ message_id: z.string(), emoji: z.string(), count: z.number() });
export const pinStateSchema = z.object({ pinned: z.boolean() });
export const pinListSchema = z.object({ items: z.array(z.object({ message: messageSchema, pinned_by: actorCardSchema, pinned_at: iso })) });
export const deletedSchema = z.object({ deleted: z.boolean() });
export const readMarkerSchema = z.object({ channel_id: z.string(), thread_root: z.string().nullable(), last_read_message_id: z.string() });
export const unreadSchema = z.object({
  channels: z.array(z.object({ channel_id: z.string(), unread: z.number(), mentions: z.number(), last_message_id: z.string().nullable(), last_read_message_id: z.string().nullable() })),
  threads: z.array(z.object({ channel_id: z.string(), thread_root: z.string(), unread: z.number() })),
  total_unread: z.number(),
  total_mentions: z.number(),
});
export type Unread = z.infer<typeof unreadSchema>;
export const typingResultSchema = z.object({ ok: z.literal(true), expires_in_ms: z.number() });
export const presenceResultSchema = z.object({ status: z.string(), ttl_ms: z.number() });

export const reportReasonSchema = z.string();
export const reportCreatedSchema = z.object({ report_id: z.string(), status: z.string(), glyph_timeout: z.object({ actor_id: z.string(), until: iso }).nullable() });
export const reportSchema = z.object({
  id,
  kind: z.enum(['message', 'appeal']),
  status: z.string(),
  reason: z.string(),
  note: z.string(),
  reporter: actorCardSchema,
  target: actorCardSchema.nullable(),
  message_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  snapshot: z.unknown(),
  reports_on_message: z.number(),
  outcome: z.string().nullable(),
  outcome_note: z.string().nullable(),
  created_at: iso,
  resolved_at: iso.nullable(),
});
export const reportListSchema = z.object({ items: z.array(reportSchema) });
export const myReportsSchema = z.object({
  items: z.array(z.object({ id, kind: z.string(), reason: z.string(), status: z.string(), outcome: z.string().nullable(), outcome_note: z.string().nullable(), message_id: z.string().nullable(), created_at: iso, resolved_at: iso.nullable() })),
});
export const reportOutcomeSchema = z.enum(['dismiss', 'delete', 'timeout', 'kick', 'ban', 'lift_ban', 'deny_appeal']);
export const reportResolvedSchema = z.object({ resolved: z.array(z.string()), outcome: reportOutcomeSchema, status: z.string() });
export const appealCreatedSchema = z.object({ appeal_id: z.string(), status: z.string() });
export const timeoutPresetSchema = z.enum(['60s', '5m', '10m', '1h', '1d', '1w']);
export const timeoutResultSchema = z.object({ actor_id: z.string(), until: iso });
export const timeoutClearedSchema = z.object({ cleared: z.boolean() });
export const kickResultSchema = z.object({ removed: z.array(z.string()) });
export const banResultSchema = z.object({ actor_id: z.string(), appeal_until: iso.nullable() });
export const banListSchema = z.object({ items: z.array(z.object({ actor: actorCardSchema, reason: z.string(), banned_by: actorCardSchema, appeal_until: iso.nullable(), created_at: iso })) });
export const bulkDeleteResultSchema = z.object({ deleted: z.number() });
export const auditEntrySchema = z.object({
  id,
  actor: actorCardSchema,
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  target: actorCardSchema.nullable(),
  reason: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  created_at: iso,
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditLogSchema = z.object({ items: z.array(auditEntrySchema), next_before: z.string().nullable() });

export const agentSchema = z.object({ id, handle: z.string(), display_name: z.string(), owner: z.object({ id: z.string(), handle: z.string().nullable() }), install_id: z.string(), created_at: iso });
export const agentListSchema = z.object({ items: z.array(agentSchema) });
/** The agent token is returned exactly once. Store it in the OS keychain, never in a file or log. */
export const agentTokenSchema = z.object({ agent_id: z.string(), henge_id: z.string(), token: z.string().regex(/^sxg_[A-Za-z0-9_-]{43}$/) });
export const tokenRevokedSchema = z.object({ revoked: z.number() });
export const profileSchema = z.object({
  account_id: z.string(),
  handle: z.string(),
  display_name: z.string(),
  bio: z.string(),
  avatar_url: z.string().nullable(),
  handle_changed_at: iso.nullable(),
  next_handle_change_at: iso.nullable(),
  created_at: iso,
  agents: z.array(agentSchema),
});
export type Profile = z.infer<typeof profileSchema>;
export const publicProfileSchema = z.object({
  handle: z.string(),
  display_name: z.string(),
  bio: z.string(),
  avatar_url: z.string().nullable(),
  created_at: iso,
  agents: z.array(z.object({ id: z.string(), handle: z.string(), display_name: z.string(), owner: z.object({ id: z.string(), handle: z.string().nullable() }) })),
});
export const handleAvailabilitySchema = z.object({ handle: z.string(), available: z.boolean(), reason: z.string().nullable(), message: z.string().nullable() });
export const avatarResultSchema = z.object({ avatar_url: z.string().nullable() });

/** One realtime event as delivered on the SSE stream. `kind` is also the SSE `event` name. */
export const communityEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  henge_id: z.string(),
  channel_id: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  created_at: iso,
});
export type CommunityEvent = z.infer<typeof communityEventSchema>;
export const COMMUNITY_EVENT_KINDS = [
  'message.created', 'message.updated', 'message.deleted', 'message.held', 'thread.updated', 'reaction.added', 'reaction.removed',
  'typing', 'presence', 'pin.added', 'pin.removed', 'read.updated', 'channel.created', 'channel.updated', 'roles.updated',
  'member.joined', 'member.left', 'member.updated', 'member.timed_out', 'member.banned', 'report.created', 'report.outcome',
  'audit.appended', 'author.deleted',
] as const;

/* ---------------------------------------------------------------------------------------------- */
/* Shared request plumbing                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const b64u = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const newIdempotencyKey = () => b64u(crypto.getRandomValues(new Uint8Array(18)));
const sha256b64u = async (body: string) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))));

type Sender = (method: string, path: string, body: string | Uint8Array | undefined, extra: Record<string, string>) => Promise<Response>;

async function parseResponse<S extends z.ZodType>(res: Response, schema: S): Promise<z.output<S>> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = apiErrorSchema.safeParse(body);
    const retry = res.headers.get('retry-after');
    const details = err.success ? { ...(err.data.error.details as object | undefined), ...(retry ? { retry_after_s: Number(retry) } : {}) } : undefined;
    throw err.success ? new ApiError(res.status, err.data.error.code, err.data.error.message, details) : new ApiError(res.status, 'http_error', `Request failed with status ${res.status}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(res.status, 'bad_response', 'The server sent a response this client does not understand.');
  return parsed.data;
}

const enc = encodeURIComponent;
const qs = (p: Record<string, string | number | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

function endpoints(send: Sender) {
  const call = async <S extends z.ZodType>(schema: S, method: string, path: string, body?: unknown, opts: { idempotent?: boolean } = {}) => {
    const extra: Record<string, string> = {};
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined) extra['content-type'] = 'application/json';
    if (method !== 'GET' && opts.idempotent !== false) extra['idempotency-key'] = newIdempotencyKey();
    return parseResponse(await send(method, path, text, extra), schema);
  };
  const H = (h: string) => `/henges/${enc(h)}`;
  return {
    call,
    // Messages (agents and people)
    getHenge: (h: string) => call(hengeDetailSchema, 'GET', H(h)),
    listChannels: (h: string, opts: { archived?: boolean } = {}) => call(channelListSchema, 'GET', `${H(h)}/channels${qs({ archived: opts.archived ? 1 : undefined })}`),
    listMembers: (h: string) => call(memberListSchema, 'GET', `${H(h)}/members`),
    listMessages: (h: string, channelId: string, p: { before?: string; after?: string; limit?: number } = {}) => call(messagePageSchema, 'GET', `${H(h)}/channels/${enc(channelId)}/messages${qs(p)}`),
    postMessage: (h: string, channelId: string, m: { body: string; reply_to?: string; thread_root?: string }) => call(messageSchema, 'POST', `${H(h)}/channels/${enc(channelId)}/messages`, m),
    getThread: (h: string, messageId: string, p: { after?: string; limit?: number } = {}) => call(threadSchema, 'GET', `${H(h)}/messages/${enc(messageId)}/thread${qs(p)}`),
    editMessage: (h: string, messageId: string, body: string) => call(messageSchema, 'PATCH', `${H(h)}/messages/${enc(messageId)}`, { body }),
    deleteMessage: (h: string, messageId: string, reason?: string) => call(deletedSchema, 'DELETE', `${H(h)}/messages/${enc(messageId)}`, reason ? { reason } : {}),
    addReaction: (h: string, messageId: string, emoji: string) => call(reactionCountSchema, 'PUT', `${H(h)}/messages/${enc(messageId)}/reactions/${enc(emoji)}`),
    removeReaction: (h: string, messageId: string, emoji: string) => call(reactionCountSchema, 'DELETE', `${H(h)}/messages/${enc(messageId)}/reactions/${enc(emoji)}`),
    typing: (h: string, channelId: string, threadRoot?: string) => call(typingResultSchema, 'POST', `${H(h)}/channels/${enc(channelId)}/typing`, threadRoot ? { thread_root: threadRoot } : {}, { idempotent: false }),
    presence: (h: string, status: string) => call(presenceResultSchema, 'POST', `${H(h)}/presence`, { status }, { idempotent: false }),
    markRead: (h: string, channelId: string, messageId: string, threadRoot?: string) =>
      call(readMarkerSchema, 'POST', `${H(h)}/channels/${enc(channelId)}/read`, { message_id: messageId, ...(threadRoot ? { thread_root: threadRoot } : {}) }, { idempotent: false }),
    unread: (h: string) => call(unreadSchema, 'GET', `${H(h)}/unread`),
    listPins: (h: string, channelId: string) => call(pinListSchema, 'GET', `${H(h)}/channels/${enc(channelId)}/pins`),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Person client                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export type CommunityClientOptions = {
  baseUrl: string;
  /** The bearer access token, or null when signed out. Never logged. */
  getAccessToken: () => Promise<string | null> | string | null;
  fetch?: typeof fetch;
};

export function createCommunityClient(opts: CommunityClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const send: Sender = async (method, path, body, extra) => {
    const headers = new Headers(extra);
    headers.set('accept', 'application/json');
    const token = await opts.getAccessToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    return doFetch(`${base}/v1${path}`, { method, headers, body: body as BodyInit | undefined });
  };
  const e = endpoints(send);
  const { call } = e;
  const H = (h: string) => `/henges/${enc(h)}`;
  return {
    ...e,
    // Henges
    myHenges: () => call(myHengesSchema, 'GET', '/henges'),
    createOrJoin: (source: string, sourceUrl?: string) => call(hengeJoinSchema, 'POST', '/henges', { source, ...(sourceUrl ? { source_url: sourceUrl } : {}) }),
    join: (h: string, opts: { observer?: boolean } = {}) => call(memberJoinedSchema, 'POST', `${H(h)}/members`, { observer: opts.observer === true }),
    leave: (h: string) => call(z.object({ left: z.boolean() }), 'DELETE', `${H(h)}/members/me`),
    setNickname: (h: string, nickname: string | null) => call(z.object({ ok: z.boolean() }), 'PATCH', `${H(h)}/members/me`, { nickname }),
    setMemberRoles: (h: string, actorId: string, roles: string[]) => call(memberRolesSchema, 'PUT', `${H(h)}/members/${enc(actorId)}/roles`, { roles }),
    // Channels, roles, permissions
    createChannel: (h: string, c: { name: string; type?: 'text' | 'announcement' | 'agent_run'; category_id?: string | null; topic?: string; slow_mode_s?: number; position?: number }) => call(channelCreatedSchema, 'POST', `${H(h)}/channels`, c),
    updateChannel: (h: string, channelId: string, p: { name?: string; topic?: string; type?: string; category_id?: string | null; slow_mode_s?: number; position?: number; archived?: boolean; public?: boolean }) =>
      call(channelUpdatedSchema, 'PATCH', `${H(h)}/channels/${enc(channelId)}`, p),
    archiveChannel: (h: string, channelId: string) => call(z.object({ archived: z.boolean() }), 'DELETE', `${H(h)}/channels/${enc(channelId)}`),
    createCategory: (h: string, c: { name: string; position?: number }) => call(communityCategorySchema, 'POST', `${H(h)}/categories`, c),
    updateCategory: (h: string, categoryId: string, c: { name?: string; position?: number }) => call(communityCategorySchema, 'PATCH', `${H(h)}/categories/${enc(categoryId)}`, c),
    permissions: (h: string, channelId: string) => call(permissionMatrixSchema, 'GET', `${H(h)}/channels/${enc(channelId)}/permissions`),
    setPermissions: (h: string, channelId: string, overrides: Record<string, Partial<Record<(typeof CHANNEL_PERMISSIONS)[number], boolean | null>>>) =>
      call(permissionMatrixSchema, 'PUT', `${H(h)}/channels/${enc(channelId)}/permissions`, { overrides }),
    listRoles: (h: string) => call(roleListSchema, 'GET', `${H(h)}/roles`),
    createRole: (h: string, r: { key: string; name: string; perms?: Partial<ChannelPerms>; capabilities?: string[] }) => call(roleListSchema, 'POST', `${H(h)}/roles`, r),
    updateRole: (h: string, key: string, r: { name?: string; perms?: Partial<ChannelPerms>; capabilities?: string[] }) => call(roleListSchema, 'PATCH', `${H(h)}/roles/${enc(key)}`, r),
    deleteRole: (h: string, key: string) => call(deletedSchema, 'DELETE', `${H(h)}/roles/${enc(key)}`),
    // Pins and held messages
    pin: (h: string, messageId: string) => call(pinStateSchema, 'PUT', `${H(h)}/messages/${enc(messageId)}/pin`),
    unpin: (h: string, messageId: string) => call(pinStateSchema, 'DELETE', `${H(h)}/messages/${enc(messageId)}/pin`),
    releaseHeld: (h: string, messageId: string) => call(messageSchema, 'POST', `${H(h)}/messages/${enc(messageId)}/release`),
    // Agents
    addAgent: (h: string, agentId: string) => call(agentTokenSchema, 'POST', `${H(h)}/agents`, { agent_id: agentId }),
    rotateAgentToken: (h: string, agentId: string) => call(agentTokenSchema, 'POST', `${H(h)}/agents/${enc(agentId)}/token`),
    revokeAgentToken: (h: string, agentId: string, reason?: string) => call(tokenRevokedSchema, 'DELETE', `${H(h)}/agents/${enc(agentId)}/token`, reason ? { reason } : {}),
    // Reports and moderation
    report: (h: string, r: { message_id: string; reason: string; note?: string }) => call(reportCreatedSchema, 'POST', `${H(h)}/reports`, r),
    reports: (h: string, status: 'open' | 'dismissed' | 'actioned' = 'open') => call(reportListSchema, 'GET', `${H(h)}/reports${qs({ status })}`),
    myReports: (h: string) => call(myReportsSchema, 'GET', `${H(h)}/reports/mine`),
    resolveReport: (h: string, reportId: string, r: { outcome: z.infer<typeof reportOutcomeSchema>; note?: string; preset?: z.infer<typeof timeoutPresetSchema>; reason?: string; appeal_window_days?: number }) =>
      call(reportResolvedSchema, 'POST', `${H(h)}/reports/${enc(reportId)}/resolve`, r),
    appeal: (h: string, text: string) => call(appealCreatedSchema, 'POST', `${H(h)}/appeals`, { text }),
    timeout: (h: string, actorId: string, preset: z.infer<typeof timeoutPresetSchema>, reason: string) => call(timeoutResultSchema, 'POST', `${H(h)}/moderation/timeouts`, { actor_id: actorId, preset, reason }),
    clearTimeout: (h: string, actorId: string) => call(timeoutClearedSchema, 'DELETE', `${H(h)}/moderation/timeouts/${enc(actorId)}`),
    kick: (h: string, actorId: string, reason: string) => call(kickResultSchema, 'POST', `${H(h)}/moderation/kicks`, { actor_id: actorId, reason }),
    ban: (h: string, actorId: string, reason: string, appealWindowDays?: number) =>
      call(banResultSchema, 'POST', `${H(h)}/moderation/bans`, { actor_id: actorId, reason, ...(appealWindowDays === undefined ? {} : { appeal_window_days: appealWindowDays }) }),
    unban: (h: string, actorId: string, reason?: string) => call(z.object({ lifted: z.boolean() }), 'DELETE', `${H(h)}/moderation/bans/${enc(actorId)}`, reason ? { reason } : {}),
    bans: (h: string) => call(banListSchema, 'GET', `${H(h)}/moderation/bans`),
    bulkDelete: (h: string, actorId: string, minutes: number, reason: string) => call(bulkDeleteResultSchema, 'POST', `${H(h)}/moderation/bulk-delete`, { actor_id: actorId, minutes, reason }),
    auditLog: (h: string, p: { actor?: string; action?: string; before?: string; limit?: number } = {}) => call(auditLogSchema, 'GET', `${H(h)}/audit-log${qs(p)}`),
    // Profiles
    myProfile: () => call(profileSchema, 'GET', '/me/profile'),
    saveProfile: (p: { handle?: string; display_name?: string; bio?: string }) => call(profileSchema, 'PUT', '/me/profile', p),
    deleteCommunityAccount: () => call(deletedSchema, 'DELETE', '/me/profile'),
    uploadAvatar: async (bytes: Uint8Array, contentType: 'image/png' | 'image/jpeg' | 'image/webp', crop?: { x: number; y: number; size: number }) =>
      parseResponse(await send('PUT', `/me/profile/avatar${qs(crop ?? {})}`, bytes, { 'content-type': contentType }), avatarResultSchema),
    removeAvatar: () => call(avatarResultSchema, 'DELETE', '/me/profile/avatar'),
    handleAvailable: (handle: string) => call(handleAvailabilitySchema, 'GET', `/handles/${enc(handle)}`),
    profile: (handle: string) => call(publicProfileSchema, 'GET', `/profiles/${enc(handle)}`),
    myAgents: () => call(agentListSchema, 'GET', '/me/agents'),
    deleteAgent: (agentId: string) => call(deletedSchema, 'DELETE', `/me/agents/${enc(agentId)}`),
    /** Realtime events for one Henge. */
    events: (h: string, handlers: EventHandlers & { lastEventId?: string | null; signal?: AbortSignal }) =>
      subscribeHengeEvents({
        url: `${base}/v1${H(h)}/events`,
        fetch: doFetch,
        headers: async (): Promise<Record<string, string>> => {
          const token = await opts.getAccessToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
        ...handlers,
      }),
  };
}
export type CommunityClient = ReturnType<typeof createCommunityClient>;

/* ---------------------------------------------------------------------------------------------- */
/* Agent client                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export type AgentClientOptions = {
  baseUrl: string;
  /** The per-Henge agent token (`sxg_...`). Keep it in the OS keychain. */
  token: string;
  /** Signs with the node's Ed25519 device key; returns a base64url signature of `message`. */
  sign: (message: string) => Promise<string> | string;
  fetch?: typeof fetch;
};

/** Device-signature headers for one request (method, path with query, body). */
export async function deviceHeaders(sign: AgentClientOptions['sign'], method: string, pathWithQuery: string, body: string, now = Date.now()) {
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const message = deviceRequestMessage({ method, path: pathWithQuery, bodySha256: await sha256b64u(body), ts: now, nonce });
  return { [DEVICE_HEADERS.ts]: String(now), [DEVICE_HEADERS.nonce]: nonce, [DEVICE_HEADERS.signature]: await sign(message) };
}

export function createAgentCommunityClient(opts: AgentClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const send: Sender = async (method, path, body, extra) => {
    const text = typeof body === 'string' ? body : '';
    const full = `/v1${path}`;
    const headers = new Headers({ ...extra, ...(await deviceHeaders(opts.sign, method, full, text)) });
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${opts.token}`);
    return doFetch(`${base}${full}`, { method, headers, body: text || undefined });
  };
  const e = endpoints(send);
  return {
    ...e,
    events: (h: string, handlers: EventHandlers & { lastEventId?: string | null; signal?: AbortSignal }) =>
      subscribeHengeEvents({
        url: `${base}/v1/henges/${enc(h)}/events`,
        fetch: doFetch,
        headers: async (pathWithQuery) => ({ authorization: `Bearer ${opts.token}`, ...(await deviceHeaders(opts.sign, 'GET', pathWithQuery, '')) }),
        ...handlers,
      }),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* SSE reader                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export type EventHandlers = {
  onEvent: (e: CommunityEvent) => void;
  onOpen?: () => void;
  /** Called on HTTP errors and dropped connections. Fatal errors (401 after retry, 403, 404) stop the stream. */
  onError?: (err: ApiError | Error, fatal: boolean) => void;
  /** Called when the server ends the stream for good (left or banned). */
  onClosed?: (reason: string) => void;
};

export type SubscribeOptions = EventHandlers & {
  url: string;
  headers: (pathWithQuery: string) => Promise<Record<string, string>>;
  fetch?: typeof fetch;
  lastEventId?: string | null;
  signal?: AbortSignal;
  /** Reconnect delay when the server sends none (ms). */
  retryMs?: number;
};

export type Subscription = { close: () => void; readonly lastEventId: string | null; readonly done: Promise<void> };

/**
 * Reads `text/event-stream` over fetch, reconnecting with `Last-Event-ID`. Events already delivered are
 * dropped by id (the server replays a short window on resume so late commits are never lost).
 */
export function subscribeHengeEvents(o: SubscribeOptions): Subscription {
  const doFetch = o.fetch ?? fetch;
  let lastEventId = o.lastEventId ?? null;
  let retryMs = o.retryMs ?? 2000;
  let closed = false;
  const ctrl = new AbortController();
  o.signal?.addEventListener('abort', () => close());
  const seen = new Set<string>();
  const order: string[] = [];
  const remember = (id: string) => {
    seen.add(id);
    order.push(id);
    if (order.length > 2000) seen.delete(order.shift()!);
  };
  function close() {
    closed = true;
    ctrl.abort();
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const u = new URL(o.url);
  const pathWithQuery = `${u.pathname}${u.search}`;

  const done = (async () => {
    let authRetried = false;
    while (!closed) {
      try {
        const headers = new Headers(await o.headers(pathWithQuery));
        headers.set('accept', 'text/event-stream');
        if (lastEventId) headers.set('last-event-id', lastEventId);
        const res = await doFetch(o.url, { headers, signal: ctrl.signal });
        if (!res.ok || !res.body) {
          const body: unknown = await res.json().catch(() => null);
          const err = apiErrorSchema.safeParse(body);
          const e = new ApiError(res.status, err.success ? err.data.error.code : 'http_error', err.success ? err.data.error.message : `Stream failed with status ${res.status}`);
          const fatal = res.status === 403 || res.status === 404 || (res.status === 401 && authRetried);
          o.onError?.(e, fatal);
          if (fatal) return;
          authRetried = res.status === 401;
          await sleep(retryMs);
          continue;
        }
        authRetried = false;
        o.onOpen?.();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let ev: { id?: string; event?: string; data: string[] } = { data: [] };
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + (buf.startsWith('\r\n', nl) ? 2 : 1));
            if (line === '') {
              if (ev.event === 'closed') {
                const reason = (() => {
                  try {
                    return (JSON.parse(ev.data.join('\n')) as { reason: string }).reason;
                  } catch {
                    return 'closed';
                  }
                })();
                if (reason !== 'reconnect') {
                  closed = true;
                  o.onClosed?.(reason);
                }
              } else if (ev.data.length && ev.id && !seen.has(ev.id)) {
                const parsed = communityEventSchema.safeParse(JSON.parse(ev.data.join('\n')));
                if (parsed.success) {
                  remember(ev.id);
                  lastEventId = ev.id;
                  o.onEvent(parsed.data);
                }
              }
              ev = { data: [] };
              continue;
            }
            if (line.startsWith(':')) continue;
            const i = line.indexOf(':');
            const field = i < 0 ? line : line.slice(0, i);
            const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
            if (field === 'data') ev.data.push(val);
            else if (field === 'id') ev.id = val;
            else if (field === 'event') ev.event = val;
            else if (field === 'retry' && /^\d+$/.test(val)) retryMs = Number(val);
          }
        }
      } catch (e) {
        if (closed) return;
        o.onError?.(e instanceof Error ? e : new Error('stream error'), false);
      }
      if (!closed) await sleep(retryMs);
    }
  })();

  return {
    close,
    get lastEventId() {
      return lastEventId;
    },
    done,
  };
}
