/**
 * The CommunityStore backed by the community service (spin-out spec v2, 8;
 * `packages/api-client/src/community.ts`). Main holds the token and runs each call; this class keeps a
 * read cache for the UI, refreshes it from realtime events, and maps the service's shapes onto the
 * renderer's.
 *
 * A Henge that is not on the service yet (signed out, or nobody named as its owner has started it)
 * still shows its channels and named members from the `.henge` file, through the in-memory model,
 * and every write says why it cannot be done.
 *
 * Proposals: the service has no proposal records yet. A proposal is posted to #proposals as a normal
 * message by you, and its details and votes are kept on this computer only.
 */
import type {
  ActorCard,
  AuditEntry as SvcAudit,
  Channel as SvcChannel,
  CommunityMessage,
  HengeDetail,
  Member as SvcMember,
  PermissionMatrix,
  Profile as SvcProfile,
  Unread,
} from '@swarm-explorer/api-client';
import type { CommunityCallResult, CommunityEventView } from '../../shared/henge';
import { InMemoryCommunityStore, mentionsIn } from './memory';
import {
  CHANNEL_PERMISSIONS,
  type AgentIdentity,
  type AuditEntry,
  type Ban,
  type Channel,
  type ChannelPermission,
  type ChannelPerms,
  type ChannelType,
  type CommunityStore,
  type HengeSeed,
  type Member,
  type Message,
  type Presence,
  type Profile,
  type Proposal,
  type Report,
  type ReportReason,
  type Result,
} from './store';

type Bridge = Window['swarm']['community'];

/** Renderer permission keys and the service's. */
const PERM: Record<ChannelPermission, keyof SvcChannel['my_perms']> = {
  view: 'view',
  send: 'send',
  threads: 'start_threads',
  mention_everyone: 'mention_everyone',
  react: 'add_reactions',
  manage: 'manage_messages',
  api: 'post_via_api',
};

const AUDIT: Record<string, AuditEntry['action']> = {
  'message.deleted': 'delete_message',
  'messages.bulk_deleted': 'bulk_delete',
  'member.timed_out': 'timeout',
  'member.kicked': 'kick',
  'member.banned': 'ban',
  'channel.slow_mode': 'slow_mode',
  'channel.updated': 'channel_settings',
  'channel.permissions_changed': 'channel_settings',
  'agent.token_revoked': 'revoke_token',
  'member.roles_changed': 'role_change',
};

const PRESETS: Array<[number, '60s' | '5m' | '10m' | '1h' | '1d' | '1w']> = [
  [1, '60s'],
  [5, '5m'],
  [10, '10m'],
  [60, '1h'],
  [1440, '1d'],
  [10080, '1w'],
];
const presetFor = (minutes: number) => (PRESETS.find(([m]) => m >= minutes) ?? PRESETS[PRESETS.length - 1]!)[1];

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const okVoid: Result = { ok: true, value: undefined };
const fail = (r: Extract<CommunityCallResult, { ok: false }>): { ok: false; message: string; retryAfterS?: number } =>
  r.retryAfterS ? { ok: false, message: r.message, retryAfterS: r.retryAfterS } : { ok: false, message: r.message };
const NOT_CONNECTED = { ok: false as const, message: 'This Henge is not on the community service yet. Only someone the file names as owner can start it there.' };

type Space = {
  communityId: string;
  detail: HengeDetail | null;
  channels: SvcChannel[];
  categories: Map<string, { key: string; name: string }>;
  members: SvcMember[];
  unread: Unread | null;
  reports: Report[];
  audit: AuditEntry[];
  bans: Ban[];
  perms: Map<string, PermissionMatrix>;
  pins: Map<string, string[]>;
  loaded: Set<string>;
  typing: Map<string, Map<string, { name: string; until: number }>>;
};

export class ApiCommunityStore implements CommunityStore {
  private listeners = new Set<() => void>();
  private v = 0;
  private local = new InMemoryCommunityStore();
  private profile: Profile | null = null;
  private profileSettled = false;
  private spaces = new Map<string, Space>();
  private byCommunityId = new Map<string, string>();
  private msgs = new Map<string, Message>();
  private threads = new Map<string, string[]>();
  private proposalsByMsg = new Map<string, Proposal>();
  private proposalList = new Map<string, Proposal[]>();
  private agentPresence: Presence = 'offline';
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bridge: Bridge = window.swarm.community,
    apiBase: Promise<string | null> = window.swarm.getAppInfo().then((i) => i?.apiBaseUrl ?? null),
  ) {
    this.local.subscribe(() => this.changed());
    bridge.onEvent((e) => this.onEvent(e));
    void apiBase.then((u) => {
      this.apiBase = u;
      this.refresh();
    });
  }

  /* Plumbing */

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  version() {
    return this.v;
  }
  ready() {
    return this.profileSettled;
  }
  private changed() {
    this.v++;
    for (const l of this.listeners) l();
  }
  private call<T>(op: string, ...args: unknown[]) {
    return this.bridge.call<T>(op, ...args);
  }
  private sp(hengeId: string) {
    return this.spaces.get(hengeId) ?? null;
  }
  private debounce(key: string, fn: () => void, ms = 120) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(fn, ms));
  }
  private svcChannel(sp: Space, channelKey: string) {
    return sp.channels.find((c) => c.key === channelKey) ?? null;
  }
  private keyOfChannel(sp: Space, id: string | null) {
    return sp.channels.find((c) => c.id === id)?.key ?? id ?? '';
  }

  refresh() {
    this.profileSettled = false;
    this.changed();
    void this.call<SvcProfile>('myProfile').then((r) => {
      this.profile = r.ok ? this.toProfile(r.value) : null;
      this.profileSettled = true;
      this.changed();
    });
  }

  connected(hengeId: string) {
    return this.spaces.has(hengeId);
  }

  /* Profiles */

  private apiBase: string | null = null;
  /** Avatars are served by the service under /v1/avatars (the CSP allows the API origin for images). */
  private avatarUrl(u: string | null) {
    if (!u) return null;
    if (/^https?:/.test(u)) return u;
    return this.apiBase && u.startsWith('/') ? new URL(u, this.apiBase).toString() : null;
  }
  private toProfile(p: SvcProfile): Profile {
    return {
      id: p.account_id,
      handle: p.handle,
      displayName: p.display_name,
      bio: p.bio,
      avatar: this.avatarUrl(p.avatar_url),
      agents: p.agents.map((a) => ({ id: a.id, handle: a.handle, displayName: a.display_name, ownerHandle: a.owner.handle ?? p.handle, modelName: null })),
    };
  }
  myProfile() {
    return this.profile;
  }
  async checkHandle(handle: string) {
    const r = await this.call<{ available: boolean; message: string | null }>('handleAvailable', handle.trim().toLowerCase());
    if (!r.ok) return { ok: false, message: r.message };
    return { ok: r.value.available, message: r.value.available ? 'Available' : (r.value.message ?? 'That handle is taken.') };
  }
  async saveProfile(p: { handle: string; displayName: string; bio: string; avatar: string | null }): Promise<Result<Profile>> {
    const r = await this.call<SvcProfile>('saveProfile', { handle: p.handle.trim().toLowerCase(), display_name: p.displayName.trim(), bio: p.bio });
    if (!r.ok) return fail(r);
    let prof = r.value;
    if (p.avatar && p.avatar.startsWith('data:')) {
      const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(p.avatar);
      if (m) {
        const bytes = Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0));
        const a = await this.bridge.uploadAvatar(bytes, m[1] as 'image/png' | 'image/jpeg' | 'image/webp');
        if (a.ok) prof = { ...prof, avatar_url: (a.value as { avatar_url: string | null }).avatar_url };
      }
    } else if (!p.avatar && prof.avatar_url) {
      await this.call('removeAvatar');
      prof = { ...prof, avatar_url: null };
    }
    this.profile = this.toProfile(prof);
    this.profileSettled = true;
    this.changed();
    return ok(this.profile);
  }
  async linkAgent(input: { modelName: string | null }): Promise<Result<AgentIdentity>> {
    if (!this.profile) return { ok: false, message: 'Set up your profile first.' };
    const existing = this.profile.agents[0];
    if (existing) return ok({ ...existing, modelName: input.modelName });
    const r = await this.bridge.createAgent(`${this.profile.handle.slice(0, 19).replace(/[._]+$/, '')}.node`, 'local-node');
    if (!r.ok) return fail(r);
    const a = r.value as { id: string; handle: string; display_name: string };
    const agent: AgentIdentity = { id: a.id, handle: a.handle, displayName: a.display_name, ownerHandle: this.profile.handle, modelName: input.modelName };
    this.profile = { ...this.profile, agents: [agent] };
    this.changed();
    return ok(agent);
  }
  profileOf(memberId: string): Member | null {
    for (const [h] of this.spaces) {
      const m = this.members(h).find((x) => x.id === memberId);
      if (m) return m;
    }
    return this.local.profileOf(memberId);
  }

  /* Spaces */

  attachHenge(seed: HengeSeed) {
    this.local.attachHenge(seed);
    const had = this.spaces.get(seed.hengeId);
    if (!seed.communityId) {
      if (had) {
        void this.bridge.unwatch(had.communityId);
        this.spaces.delete(seed.hengeId);
        this.byCommunityId.delete(had.communityId);
        this.changed();
      }
      return;
    }
    if (had?.communityId === seed.communityId) return;
    const sp: Space = { communityId: seed.communityId, detail: null, channels: [], categories: new Map(), members: [], unread: null, reports: [], audit: [], bans: [], perms: new Map(), pins: new Map(), loaded: new Set(), typing: new Map() };
    this.spaces.set(seed.hengeId, sp);
    this.byCommunityId.set(seed.communityId, seed.hengeId);
    void this.bridge.watch(seed.communityId);
    void this.loadSpace(seed.hengeId);
    this.startHeartbeat();
  }
  detachHenge(hengeId: string) {
    this.local.detachHenge(hengeId);
    const sp = this.spaces.get(hengeId);
    if (!sp) return;
    void this.bridge.unwatch(sp.communityId);
    this.spaces.delete(hengeId);
    this.byCommunityId.delete(sp.communityId);
    this.changed();
  }
  private startHeartbeat() {
    if (this.heartbeat) return;
    const beat = () => {
      for (const sp of this.spaces.values()) void this.call('presence', sp.communityId, 'online');
    };
    beat();
    this.heartbeat = setInterval(beat, 45_000);
  }

  private async loadSpace(hengeId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return;
    const [d, ch, mem, un] = await Promise.all([
      this.call<HengeDetail>('getHenge', sp.communityId),
      this.call<{ categories: Array<{ id: string; key: string; name: string }>; channels: SvcChannel[] }>('listChannels', sp.communityId),
      this.call<{ items: SvcMember[] }>('listMembers', sp.communityId),
      this.call<Unread>('unread', sp.communityId),
    ]);
    if (d.ok) sp.detail = d.value;
    if (ch.ok) {
      sp.channels = ch.value.channels.filter((c) => !c.archived);
      sp.categories = new Map(ch.value.categories.map((c) => [c.id, { key: c.key, name: c.name }]));
    }
    if (mem.ok) sp.members = mem.value.items;
    if (un.ok) sp.unread = un.value;
    this.changed();
  }
  private async loadMembers(hengeId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return;
    const r = await this.call<{ items: SvcMember[] }>('listMembers', sp.communityId);
    if (r.ok) sp.members = r.value.items;
    this.changed();
  }
  private async loadUnread(hengeId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return;
    const r = await this.call<Unread>('unread', sp.communityId);
    if (r.ok) sp.unread = r.value;
    this.changed();
  }

  channels(hengeId: string): Channel[] {
    const sp = this.sp(hengeId);
    if (!sp || !sp.channels.length) return this.local.channels(hengeId);
    const fileCh = new Map(this.local.channels(hengeId).map((c) => [c.id, c]));
    return [...sp.channels]
      .sort((a, b) => {
        const ca = a.category_id ? [...sp.categories.keys()].indexOf(a.category_id) : -1;
        const cb = b.category_id ? [...sp.categories.keys()].indexOf(b.category_id) : -1;
        return ca - cb || a.position - b.position;
      })
      .map((c) => {
        const cat = c.category_id ? sp.categories.get(c.category_id) : undefined;
        const f = fileCh.get(c.key);
        return {
          id: c.key,
          name: c.name,
          type: c.type,
          categoryId: cat?.key ?? 'channels',
          categoryName: cat?.name ?? 'Channels',
          slowModeS: c.slow_mode_s,
          post: f?.post ?? null,
          read: f?.read ?? null,
          glyphPosts: c.glyph_posts,
          agentsRule: c.agents_policy,
        };
      });
  }

  private card(a: ActorCard, roles: string[], presence: string): Member {
    const me = this.profile;
    const you = Boolean(me && (a.id === me.id || a.owner?.id === me.id || me.agents.some((x) => x.id === a.id)));
    const agent = a.type === 'agent';
    const p: Presence = agent && you ? this.agentPresence : (['online', 'idle', 'dnd', 'offline', 'running', 'paused'].includes(presence) ? presence : 'offline') as Presence;
    return {
      id: a.id,
      actorType: agent ? 'agent' : 'human',
      handle: a.handle ?? a.display_name,
      displayName: a.display_name,
      roles,
      presence: p,
      ownerHandle: a.owner?.handle ?? undefined,
      avatar: this.avatarUrl(a.avatar_url),
      bio: you && !agent ? me?.bio : undefined,
      you,
    };
  }
  members(hengeId: string): Member[] {
    const sp = this.sp(hengeId);
    if (!sp) return this.local.members(hengeId);
    return sp.members.map((m) => this.card(m.actor, m.roles, m.presence));
  }
  setAgentPresence(p: Presence) {
    this.local.setAgentPresence(p);
    if (p === this.agentPresence) return;
    this.agentPresence = p;
    this.changed();
  }
  myRoles(hengeId: string) {
    const sp = this.sp(hengeId);
    return sp?.detail ? sp.detail.me.roles : this.local.myRoles(hengeId);
  }
  can(hengeId: string, channelId: string, role: string, perm: ChannelPermission): boolean {
    const sp = this.sp(hengeId);
    if (!sp) return this.local.can(hengeId, channelId, role, perm);
    const m = sp.perms.get(channelId);
    const row = m?.roles.find((r) => r.key === role);
    if (row) return row.effective[PERM[perm]];
    const c = this.svcChannel(sp, channelId);
    if (c && sp.detail?.me.roles.includes(role)) return c.my_perms[PERM[perm]];
    return this.local.can(hengeId, channelId, role, perm);
  }

  /* Messages */

  private toMessage(sp: Space, hengeId: string, m: CommunityMessage): Message {
    const meId = sp.detail?.me.actor_id;
    const reactions: Record<string, string[]> = {};
    for (const r of m.reactions) reactions[r.emoji] = [...(r.me && meId ? [meId] : []), ...Array.from({ length: Math.max(0, r.count - (r.me ? 1 : 0)) }, (_, i) => `other:${i}`)];
    const prop = this.proposalsByMsg.get(m.id);
    return {
      id: m.id,
      hengeId,
      channelId: this.keyOfChannel(sp, m.channel_id),
      authorId: m.author.id,
      authorType: m.author.type === 'agent' ? 'agent' : m.author.type === 'glyph' || m.author.type === 'system' ? 'glyph' : 'human',
      authorName: m.author.display_name,
      authorOwner: m.author.owner?.handle ?? undefined,
      body: m.deleted ? '' : (m.body ?? ''),
      createdAt: Date.parse(m.created_at),
      editedAt: m.edited_at ? Date.parse(m.edited_at) : null,
      deletedAt: m.deleted ? Date.parse(m.created_at) : null,
      replyTo: m.reply_to?.id ?? null,
      threadRoot: m.thread_root,
      reactions,
      pinned: m.pinned,
      mentions: mentionsIn(m.body ?? ''),
      ...(prop ? { proposal: { proposalId: prop.id } } : {}),
    };
  }
  private put(sp: Space, hengeId: string, m: CommunityMessage) {
    const msg = this.toMessage(sp, hengeId, m);
    this.msgs.set(msg.id, msg);
    if (msg.threadRoot) {
      const t = this.threads.get(msg.threadRoot) ?? [];
      if (!t.includes(msg.id)) this.threads.set(msg.threadRoot, [...t, msg.id]);
    }
    return msg;
  }
  private async loadMessages(hengeId: string, channelKey: string) {
    const sp = this.sp(hengeId);
    const c = sp && this.svcChannel(sp, channelKey);
    if (!sp || !c) return;
    const r = await this.call<{ items: CommunityMessage[] }>('listMessages', sp.communityId, c.id, { limit: 100 });
    if (!r.ok) return;
    for (const old of [...this.msgs.values()]) if (old.hengeId === hengeId && old.channelId === channelKey && !old.threadRoot) this.msgs.delete(old.id);
    for (const m of r.value.items) this.put(sp, hengeId, m);
    this.changed();
  }
  messages(hengeId: string, channelId: string): Message[] {
    const sp = this.sp(hengeId);
    if (!sp) return [];
    const k = `m:${channelId}`;
    if (!sp.loaded.has(k) && this.svcChannel(sp, channelId)) {
      sp.loaded.add(k);
      void this.loadMessages(hengeId, channelId);
    }
    return [...this.msgs.values()].filter((m) => m.hengeId === hengeId && m.channelId === channelId && !m.threadRoot).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  private async loadThread(hengeId: string, rootId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return;
    const r = await this.call<{ root: CommunityMessage; items: CommunityMessage[] }>('getThread', sp.communityId, rootId, { limit: 100 });
    if (!r.ok) return;
    this.put(sp, hengeId, r.value.root);
    for (const m of r.value.items) this.put(sp, hengeId, m);
    this.changed();
  }
  thread(rootId: string): Message[] {
    const root = this.msgs.get(rootId);
    if (root) {
      const sp = this.sp(root.hengeId);
      if (sp && !sp.loaded.has(`t:${rootId}`)) {
        sp.loaded.add(`t:${rootId}`);
        void this.loadThread(root.hengeId, rootId);
      }
    }
    return (this.threads.get(rootId) ?? []).map((id) => this.msgs.get(id)).filter((m): m is Message => Boolean(m)).sort((a, b) => a.createdAt - b.createdAt);
  }
  message(id: string) {
    return this.msgs.get(id) ?? null;
  }
  async send(hengeId: string, channelId: string, body: string, opts: { threadRoot?: string; replyTo?: string } = {}): Promise<Result<Message>> {
    const sp = this.sp(hengeId);
    if (!sp) return NOT_CONNECTED;
    const c = this.svcChannel(sp, channelId);
    if (!c) return { ok: false, message: 'That channel is not on the community service.' };
    const r = await this.call<CommunityMessage>('postMessage', sp.communityId, c.id, { body, ...(opts.replyTo ? { reply_to: opts.replyTo } : {}), ...(opts.threadRoot ? { thread_root: opts.threadRoot } : {}) });
    if (!r.ok) return fail(r);
    const m = this.put(sp, hengeId, r.value);
    this.changed();
    return ok(m);
  }
  private async simple(hengeId: string, op: string, ...args: unknown[]): Promise<Result> {
    const r = await this.call(op, ...args);
    if (!r.ok) return fail(r);
    this.changed();
    void hengeId;
    return okVoid;
  }
  async edit(messageId: string, body: string): Promise<Result> {
    const m = this.msgs.get(messageId);
    const sp = m && this.sp(m.hengeId);
    if (!m || !sp) return { ok: false, message: 'That message is gone.' };
    const r = await this.call<CommunityMessage>('editMessage', sp.communityId, messageId, body);
    if (!r.ok) return fail(r);
    this.put(sp, m.hengeId, r.value);
    this.changed();
    return okVoid;
  }
  async remove(messageId: string, reason?: string): Promise<Result> {
    const m = this.msgs.get(messageId);
    const sp = m && this.sp(m.hengeId);
    if (!m || !sp) return { ok: false, message: 'That message is gone.' };
    const r = await this.simple(m.hengeId, 'deleteMessage', sp.communityId, messageId, reason);
    if (r.ok) this.msgs.set(messageId, { ...m, body: '', deletedAt: Date.now() });
    this.changed();
    return r;
  }
  async react(messageId: string, emoji: string): Promise<Result> {
    const m = this.msgs.get(messageId);
    const sp = m && this.sp(m.hengeId);
    if (!m || !sp) return { ok: false, message: 'That message is gone.' };
    const meId = sp.detail?.me.actor_id ?? '';
    const mine = (m.reactions[emoji] ?? []).includes(meId);
    const r = await this.call<{ count: number }>(mine ? 'removeReaction' : 'addReaction', sp.communityId, messageId, emoji);
    if (!r.ok) return fail(r);
    const others = (m.reactions[emoji] ?? []).filter((x) => x !== meId);
    const who = mine ? others : [meId, ...others];
    const reactions = { ...m.reactions };
    if (who.length) reactions[emoji] = who;
    else delete reactions[emoji];
    this.msgs.set(messageId, { ...m, reactions });
    this.changed();
    return okVoid;
  }
  async pin(messageId: string): Promise<Result> {
    const m = this.msgs.get(messageId);
    const sp = m && this.sp(m.hengeId);
    if (!m || !sp) return { ok: false, message: 'That message is gone.' };
    const r = await this.call<{ pinned: boolean }>(m.pinned ? 'unpin' : 'pin', sp.communityId, messageId);
    if (!r.ok) return fail(r);
    this.msgs.set(messageId, { ...m, pinned: r.value.pinned });
    sp.loaded.delete(`p:${m.channelId}`);
    this.changed();
    return okVoid;
  }
  pins(hengeId: string, channelId: string): Message[] {
    const sp = this.sp(hengeId);
    const c = sp && this.svcChannel(sp, channelId);
    if (!sp || !c) return [];
    if (!sp.loaded.has(`p:${channelId}`)) {
      sp.loaded.add(`p:${channelId}`);
      void this.call<{ items: Array<{ message: CommunityMessage }> }>('listPins', sp.communityId, c.id).then((r) => {
        if (!r.ok) return;
        sp.pins.set(channelId, r.value.items.map((p) => this.put(sp, hengeId, p.message).id));
        this.changed();
      });
    }
    return (sp.pins.get(channelId) ?? []).map((id) => this.msgs.get(id)).filter((m): m is Message => Boolean(m && m.pinned));
  }

  /* Unread and typing */

  unread(hengeId: string, channelId: string) {
    const sp = this.sp(hengeId);
    const c = sp && this.svcChannel(sp, channelId);
    const u = c ? sp!.unread?.channels.find((x) => x.channel_id === c.id) : undefined;
    return { count: u?.unread ?? 0, mentions: u?.mentions ?? 0 };
  }
  hengeUnread(hengeId: string) {
    const u = this.sp(hengeId)?.unread;
    return { count: u?.total_unread ?? 0, mentions: u?.total_mentions ?? 0 };
  }
  markRead(hengeId: string, channelId: string) {
    const sp = this.sp(hengeId);
    const c = sp && this.svcChannel(sp, channelId);
    if (!sp || !c) return;
    const last = this.messages(hengeId, channelId).at(-1);
    const u = sp.unread?.channels.find((x) => x.channel_id === c.id);
    if (!last || (u && u.last_read_message_id === last.id && u.unread === 0)) return;
    this.debounce(`read:${hengeId}:${channelId}`, () => {
      void this.call('markRead', sp.communityId, c.id, last.id).then(() => this.loadUnread(hengeId));
    }, 400);
  }
  typing(hengeId: string, channelId: string) {
    const t = this.sp(hengeId)?.typing.get(channelId);
    if (!t) return [];
    const now = Date.now();
    return [...t.values()].filter((x) => x.until > now).map((x) => x.name);
  }
  setTyping(hengeId: string, channelId: string, on: boolean) {
    const sp = this.sp(hengeId);
    const c = sp && this.svcChannel(sp, channelId);
    if (!sp || !c || !on) return;
    this.debounce(`typing:${hengeId}:${channelId}`, () => void this.call('typing', sp.communityId, c.id), 300);
  }

  /* Proposals: posted as messages; details and votes stay on this computer */

  async openProposal(input: { hengeId: string; channelId: string; glyphId: string; title: string; body: string; changes: Record<string, unknown> }): Promise<Result<Proposal>> {
    const sp = this.sp(input.hengeId);
    if (!sp) return NOT_CONNECTED;
    if (!this.profile) return { ok: false, message: 'Set up your profile to open a proposal.' };
    const list = this.proposalList.get(input.hengeId) ?? [];
    const number = list.length + 1;
    const changes = Object.entries(input.changes).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    const text = `**Proposal #${number}: ${input.title}**\n${input.body}${changes.length ? `\nProposed changes: ${changes.join('; ')}` : ''}`;
    const channel = this.svcChannel(sp, input.channelId) ? input.channelId : (this.channels(input.hengeId).find((c) => c.glyphPosts.includes('governance'))?.id ?? input.channelId);
    const r = await this.send(input.hengeId, channel, text);
    if (!r.ok) return r;
    const p: Proposal = { id: `prp_${r.value.id}`, number, hengeId: input.hengeId, glyphId: input.glyphId, title: input.title, body: input.body, changes: input.changes, status: 'open', votes: {}, openedBy: this.profile.handle, createdAt: r.value.createdAt };
    this.proposalList.set(input.hengeId, [...list, p]);
    this.proposalsByMsg.set(r.value.id, p);
    this.msgs.set(r.value.id, { ...r.value, proposal: { proposalId: p.id } });
    this.changed();
    return ok(p);
  }
  proposal(id: string) {
    for (const l of this.proposalList.values()) {
      const p = l.find((x) => x.id === id);
      if (p) return p;
    }
    return null;
  }
  proposals(hengeId: string) {
    return this.proposalList.get(hengeId) ?? [];
  }
  async vote(proposalId: string, choice: 'yes' | 'no'): Promise<Result> {
    const p = this.proposal(proposalId);
    if (!p || !this.profile) return { ok: false, message: 'That proposal is not open here.' };
    p.votes = { ...p.votes, [this.profile.id]: choice };
    this.changed();
    return okVoid;
  }

  /* Moderation */

  async report(messageId: string, reason: ReportReason): Promise<Result<Report>> {
    const m = this.msgs.get(messageId);
    const sp = m && this.sp(m.hengeId);
    if (!m || !sp) return { ok: false, message: 'That message is gone.' };
    const r = await this.call<{ report_id: string; status: string }>('report', sp.communityId, { message_id: messageId, reason });
    if (!r.ok) return fail(r);
    const rep: Report = { id: r.value.report_id, hengeId: m.hengeId, messageId, snapshot: { authorId: m.authorId, authorName: m.authorName, body: m.body, channelId: m.channelId }, reason, reporterId: this.profile?.id ?? '', createdAt: Date.now(), status: 'open', outcome: null };
    this.changed();
    return ok(rep);
  }
  private async loadReports(hengeId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return;
    const r = await this.call<{ items: Array<{ id: string; status: string; reason: string; reporter: ActorCard; target: ActorCard | null; message_id: string | null; channel_id: string | null; snapshot: unknown; outcome: string | null; outcome_note: string | null; created_at: string }> }>('reports', sp.communityId, 'open');
    if (!r.ok) return;
    sp.reports = r.value.items.map((x) => {
      const snap = (x.snapshot ?? {}) as { body?: string };
      return {
        id: x.id,
        hengeId,
        messageId: x.message_id ?? '',
        snapshot: { authorId: x.target?.id ?? '', authorName: x.target?.display_name ?? 'someone', body: snap.body ?? '', channelId: this.keyOfChannel(sp, x.channel_id) },
        reason: x.reason as ReportReason,
        reporterId: x.reporter.id,
        createdAt: Date.parse(x.created_at),
        status: x.status === 'dismissed' ? 'dismissed' : x.status === 'actioned' ? 'actioned' : 'open',
        outcome: x.outcome_note ?? x.outcome,
      };
    });
    this.changed();
  }
  reports(hengeId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return [];
    if (!sp.loaded.has('reports')) {
      sp.loaded.add('reports');
      void this.loadReports(hengeId);
    }
    return sp.reports;
  }
  async resolveReport(reportId: string, action: 'dismiss' | 'delete' | 'timeout' | 'kick' | 'ban'): Promise<Result> {
    for (const [hengeId, sp] of this.spaces) {
      if (!sp.reports.some((r) => r.id === reportId)) continue;
      const r = await this.call('resolveReport', sp.communityId, reportId, { outcome: action, ...(action === 'timeout' ? { preset: '1h' } : {}) });
      if (!r.ok) return fail(r);
      void this.loadReports(hengeId);
      void this.loadAudit(hengeId);
      return okVoid;
    }
    return { ok: false, message: 'That report does not exist.' };
  }
  async moderate(hengeId: string, a: { kind: 'timeout' | 'kick' | 'ban' | 'revoke_token' | 'bulk_delete'; targetId: string; minutes?: number; reason: string }): Promise<Result> {
    const sp = this.sp(hengeId);
    if (!sp) return NOT_CONNECTED;
    const reason = a.reason.trim() || 'No reason given.';
    const h = sp.communityId;
    const r =
      a.kind === 'timeout'
        ? await this.call('timeout', h, a.targetId, presetFor(a.minutes ?? 60), reason)
        : a.kind === 'kick'
          ? await this.call('kick', h, a.targetId, reason)
          : a.kind === 'ban'
            ? await this.call('ban', h, a.targetId, reason)
            : a.kind === 'revoke_token'
              ? await this.call('revokeAgentToken', h, a.targetId, reason)
              : await this.call('bulkDelete', h, a.targetId, a.minutes ?? 60, reason);
    if (!r.ok) return fail(r);
    void this.loadAudit(hengeId);
    void this.loadMembers(hengeId);
    sp.loaded.delete('bans');
    return okVoid;
  }

  private async loadPerms(hengeId: string, channelId: string) {
    const sp = this.sp(hengeId);
    const c = sp && this.svcChannel(sp, channelId);
    if (!sp || !c) return;
    const r = await this.call<PermissionMatrix>('permissions', sp.communityId, c.id);
    if (r.ok) sp.perms.set(channelId, r.value);
    this.changed();
  }
  channelPerms(hengeId: string, channelId: string): ChannelPerms {
    const sp = this.sp(hengeId);
    if (!sp) return this.local.channelPerms(hengeId, channelId);
    if (!sp.loaded.has(`perm:${channelId}`)) {
      sp.loaded.add(`perm:${channelId}`);
      void this.loadPerms(hengeId, channelId);
    }
    const m = sp.perms.get(channelId);
    const out = {} as ChannelPerms;
    for (const p of CHANNEL_PERMISSIONS) {
      out[p.key] = {};
      for (const role of m?.roles ?? []) {
        const o = role.overrides[PERM[p.key]];
        out[p.key][role.key] = o === true ? 'allow' : o === false ? 'deny' : 'inherit';
      }
    }
    return out;
  }
  /** Roles as the service has them for this Henge (the matrix columns). */
  roles(hengeId: string, channelId: string): string[] | null {
    return this.sp(hengeId)?.perms.get(channelId)?.roles.map((r) => r.key) ?? null;
  }
  async saveChannelSettings(hengeId: string, channelId: string, s: { type: ChannelType; categoryId: string; slowModeS: number; perms: ChannelPerms }): Promise<Result> {
    const sp = this.sp(hengeId);
    const c = sp && this.svcChannel(sp, channelId);
    if (!sp || !c) return NOT_CONNECTED;
    const catId = [...sp.categories.entries()].find(([, v]) => v.key === s.categoryId)?.[0] ?? c.category_id;
    const u = await this.call('updateChannel', sp.communityId, c.id, { type: s.type, category_id: catId, slow_mode_s: s.slowModeS });
    if (!u.ok) return fail(u);
    const overrides: Record<string, Record<string, boolean | null>> = {};
    for (const p of CHANNEL_PERMISSIONS)
      for (const [role, st] of Object.entries(s.perms[p.key])) (overrides[role] ??= {})[PERM[p.key]] = st === 'allow' ? true : st === 'deny' ? false : null;
    const r = await this.call<PermissionMatrix>('setPermissions', sp.communityId, c.id, overrides);
    if (!r.ok) return fail(r);
    sp.perms.set(channelId, r.value);
    void this.loadSpace(hengeId);
    void this.loadAudit(hengeId);
    return okVoid;
  }

  private async loadAudit(hengeId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return;
    const r = await this.call<{ items: SvcAudit[] }>('auditLog', sp.communityId, { limit: 100 });
    if (!r.ok) return;
    sp.audit = r.value.items.map((e) => {
      const action = AUDIT[e.action] ?? 'other';
      return {
        id: e.id,
        hengeId,
        actorId: e.actor.id,
        actorName: e.actor.handle ?? e.actor.display_name,
        actorType: e.actor.type === 'agent' ? 'agent' : e.actor.type === 'human' ? 'human' : 'glyph',
        action,
        ...(action === 'other' ? { label: e.action } : {}),
        target: e.target?.handle ?? e.target?.display_name ?? (e.target_type === 'channel' ? `#${this.keyOfChannel(sp, e.target_id)}` : (e.target_id ?? '')),
        reason: e.reason ?? '',
        createdAt: Date.parse(e.created_at),
      };
    });
    this.changed();
  }
  auditLog(hengeId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return [];
    if (!sp.loaded.has('audit')) {
      sp.loaded.add('audit');
      void this.loadAudit(hengeId);
    }
    return sp.audit;
  }
  bans(hengeId: string) {
    const sp = this.sp(hengeId);
    if (!sp) return [];
    if (!sp.loaded.has('bans')) {
      sp.loaded.add('bans');
      void this.call<{ items: Array<{ actor: ActorCard; reason: string; created_at: string }> }>('bans', sp.communityId).then((r) => {
        if (!r.ok) return;
        sp.bans = r.value.items.map((b) => ({ targetId: b.actor.id, targetName: b.actor.handle ?? b.actor.display_name, reason: b.reason, at: Date.parse(b.created_at) }));
        this.changed();
      });
    }
    return sp.bans;
  }

  /* Realtime */

  private onEvent(e: CommunityEventView) {
    const hengeId = this.byCommunityId.get(e.henge_id);
    const sp = hengeId ? this.sp(hengeId) : null;
    if (!hengeId || !sp) return;
    const channelKey = e.channel_id ? this.keyOfChannel(sp, e.channel_id) : null;
    const msg = e.payload['message'] as CommunityMessage | undefined;
    switch (e.kind) {
      case 'message.created':
      case 'message.updated':
      case 'message.deleted':
      case 'message.held':
      case 'thread.updated':
      case 'reaction.added':
      case 'reaction.removed':
      case 'pin.added':
      case 'pin.removed':
        if (msg && typeof msg === 'object' && 'id' in msg) {
          this.put(sp, hengeId, msg);
          this.changed();
        } else if (channelKey) this.debounce(`msgs:${hengeId}:${channelKey}`, () => void this.loadMessages(hengeId, channelKey));
        if (e.kind === 'pin.added' || e.kind === 'pin.removed') sp.loaded.delete(`p:${channelKey}`);
        this.debounce(`unread:${hengeId}`, () => void this.loadUnread(hengeId), 300);
        break;
      case 'typing': {
        if (!channelKey) break;
        const actor = e.payload['actor'] as ActorCard | undefined;
        if (!actor || actor.id === sp.detail?.me.actor_id) break;
        const t = sp.typing.get(channelKey) ?? new Map();
        t.set(actor.id, { name: actor.display_name, until: Date.now() + 6000 });
        sp.typing.set(channelKey, t);
        this.changed();
        setTimeout(() => this.changed(), 6100);
        break;
      }
      case 'read.updated':
        this.debounce(`unread:${hengeId}`, () => void this.loadUnread(hengeId), 300);
        break;
      case 'presence':
      case 'member.joined':
      case 'member.left':
      case 'member.updated':
      case 'member.timed_out':
      case 'member.banned':
      case 'roles.updated':
      case 'author.deleted':
        this.debounce(`members:${hengeId}`, () => void this.loadMembers(hengeId), 300);
        break;
      case 'channel.created':
      case 'channel.updated':
        this.debounce(`space:${hengeId}`, () => void this.loadSpace(hengeId), 300);
        sp.perms.clear();
        for (const k of [...sp.loaded]) if (k.startsWith('perm:')) sp.loaded.delete(k);
        break;
      case 'report.created':
      case 'report.outcome':
        this.debounce(`reports:${hengeId}`, () => void this.loadReports(hengeId), 300);
        break;
      case 'audit.appended':
        this.debounce(`audit:${hengeId}`, () => void this.loadAudit(hengeId), 300);
        break;
      case 'stream.closed':
        this.debounce(`members:${hengeId}`, () => void this.loadSpace(hengeId), 300);
        break;
    }
  }
}
