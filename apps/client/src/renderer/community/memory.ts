/**
 * In-memory CommunityStore for dev and test builds, until the community server (spin-out spec v2, 8.2)
 * is wired. It starts empty: channels and the roster come from the `.henge` file, messages only from
 * what you send on this computer. Nothing persists across restarts and nothing leaves this process.
 */
import type { HengeV1 } from '@swarm-explorer/schema';
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

/** Handles nobody may take (8.2), plus the built-in Glyph names. */
export const RESERVED_HANDLES = ['admin', 'henge', 'verafy', 'mod', 'everyone', 'here', 'system', 'glyph', 'governance', 'treasury', 'benchmark', 'strategy', 'learnings', 'moderation'];
export const HANDLE_RE = /^[a-z0-9._]{3,24}$/;

type Space = {
  henge: HengeV1;
  myRole: string;
  channels: Channel[];
  members: Member[];
  overrides: Record<string, Partial<ChannelPerms>>;
  lastRead: Record<string, number>;
  typing: Record<string, Set<string>>;
  audit: AuditEntry[];
  bans: Ban[];
  timeouts: Record<string, number>;
  reports: Report[];
  proposals: Proposal[];
  lastSent: Record<string, number[]>;
};

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const okVoid: Result = { ok: true, value: undefined };
const no = (message: string, retryAfterS?: number): { ok: false; message: string; retryAfterS?: number } => (retryAfterS === undefined ? { ok: false, message } : { ok: false, message, retryAfterS });

const MENTION_RE = /(^|[^a-z0-9._])@([a-z0-9._]{2,24})/gi;
export function mentionsIn(body: string): string[] {
  return [...body.matchAll(MENTION_RE)].map((m) => m[2]!.toLowerCase());
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class InMemoryCommunityStore implements CommunityStore {
  private listeners = new Set<() => void>();
  private v = 0;
  private profile: Profile | null = null;
  private spaces = new Map<string, Space>();
  private msgs = new Map<string, Message>();
  private seq = 0;
  private agentPresence: Presence = 'offline';
  constructor(private readonly now: () => number = Date.now) {}

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  version() {
    return this.v;
  }
  private changed() {
    this.v++;
    for (const l of this.listeners) l();
  }
  private id(prefix: string) {
    this.seq++;
    return `${prefix}_${this.now().toString(36)}${this.seq.toString(36).padStart(4, '0')}`;
  }

  /* Profiles */

  myProfile() {
    return this.profile;
  }

  private takenHandles(): Set<string> {
    const s = new Set<string>();
    for (const sp of this.spaces.values()) for (const m of sp.members) if (!m.you) s.add(m.handle.toLowerCase());
    return s;
  }

  async checkHandle(raw: string) {
    const h = raw.trim().toLowerCase().normalize('NFKC');
    if (!HANDLE_RE.test(h)) return { ok: false, message: '3 to 24 characters: lowercase letters, numbers, dot and underscore.' };
    if (RESERVED_HANDLES.includes(h)) return { ok: false, message: 'That handle is reserved.' };
    if (this.takenHandles().has(h)) return { ok: false, message: 'That handle is taken.' };
    return { ok: true, message: 'Available' };
  }

  async saveProfile(p: { handle: string; displayName: string; bio: string; avatar: string | null }): Promise<Result<Profile>> {
    const handle = p.handle.trim().toLowerCase();
    const check = await this.checkHandle(handle);
    if (!check.ok && handle !== this.profile?.handle) return no(check.message);
    const displayName = p.displayName.trim();
    if (displayName.length < 1 || displayName.length > 32) return no('Display name must be 1 to 32 characters.');
    if (p.bio.length > 190) return no('Bio must be 190 characters or fewer.');
    this.profile = { id: this.profile?.id ?? this.id('usr'), handle, displayName, bio: p.bio, avatar: p.avatar, agents: this.profile?.agents ?? [] };
    for (const sp of this.spaces.values()) this.placeMe(sp);
    this.changed();
    return ok(this.profile);
  }

  async linkAgent(input: { modelName: string | null }): Promise<Result<AgentIdentity>> {
    if (!this.profile) return no('Set up your profile first.');
    const existing = this.profile.agents[0];
    const agent: AgentIdentity = existing
      ? { ...existing, modelName: input.modelName }
      : { id: this.id('agt'), handle: `${this.profile.handle}/local-node`, displayName: 'local-node', ownerHandle: this.profile.handle, modelName: input.modelName };
    this.profile = { ...this.profile, agents: [agent] };
    for (const sp of this.spaces.values()) this.placeMe(sp);
    this.changed();
    return ok(agent);
  }

  profileOf(memberId: string): Member | null {
    for (const sp of this.spaces.values()) {
      const m = sp.members.find((x) => x.id === memberId);
      if (m) return m;
    }
    return null;
  }

  /* Spaces */

  attachHenge(seed: HengeSeed) {
    const existing = this.spaces.get(seed.hengeId);
    if (existing && existing.henge.version === seed.henge.version && existing.myRole === seed.myRole) return;
    const channels: Channel[] = [];
    for (const cat of seed.henge.community?.categories ?? [])
      for (const ch of cat.channels)
        channels.push({
          id: ch.id,
          name: ch.name ?? ch.id,
          type: ch.type,
          categoryId: cat.id,
          categoryName: cat.name ?? titleCase(cat.id),
          slowModeS: existing?.channels.find((c) => c.id === ch.id)?.slowModeS ?? ch.slow_mode_s ?? 0,
          post: ch.post ?? null,
          read: ch.read ?? null,
          glyphPosts: ch.glyph_posts ?? [],
          agentsRule: ch.agents ?? null,
        });
    const sp: Space = existing
      ? { ...existing, henge: seed.henge, myRole: seed.myRole, channels }
      : { henge: seed.henge, myRole: seed.myRole, channels, members: [], overrides: {}, lastRead: {}, typing: {}, audit: [], bans: [], timeouts: {}, reports: [], proposals: [], lastSent: {} };
    if (!existing) {
      // People the file names as role holders. Their presence is unknown here, so they show offline.
      for (const [role, handles] of Object.entries(seed.henge.governance.holders))
        for (const handle of handles) {
          const m = sp.members.find((x) => x.handle === handle);
          if (m) {
            if (!m.roles.includes(role)) m.roles.push(role);
          } else sp.members.push({ id: `holder:${handle}`, actorType: 'human', handle, displayName: handle, roles: [role], presence: 'offline' });
        }
    }
    this.spaces.set(seed.hengeId, sp);
    this.placeMe(sp);
    this.changed();
  }

  detachHenge(hengeId: string) {
    if (this.spaces.delete(hengeId)) this.changed();
  }

  /** You and your linked agent in a space's roster. */
  private placeMe(sp: Space) {
    sp.members = sp.members.filter((m) => !m.you);
    const p = this.profile;
    const me: Member = p
      ? { id: p.id, actorType: 'human', handle: p.handle, displayName: p.displayName, roles: [sp.myRole], presence: 'online', avatar: p.avatar, bio: p.bio, you: true }
      : { id: 'local:you', actorType: 'human', handle: 'you', displayName: 'you', roles: [sp.myRole], presence: 'online', you: true };
    sp.members = sp.members.filter((m) => m.handle !== me.handle);
    sp.members.unshift(me);
    for (const a of p?.agents ?? [])
      sp.members.push({ id: a.id, actorType: 'agent', handle: a.handle, displayName: a.displayName, roles: ['agent'], presence: this.agentPresence, ownerHandle: a.ownerHandle, you: true });
  }

  channels(hengeId: string) {
    return this.spaces.get(hengeId)?.channels ?? [];
  }
  members(hengeId: string) {
    return this.spaces.get(hengeId)?.members ?? [];
  }
  myRoles(hengeId: string) {
    const sp = this.spaces.get(hengeId);
    return sp ? [sp.myRole] : [];
  }

  setAgentPresence(p: Presence) {
    if (p === this.agentPresence) return;
    this.agentPresence = p;
    for (const sp of this.spaces.values()) for (const m of sp.members) if (m.you && m.actorType === 'agent') m.presence = p;
    this.changed();
  }

  /** Henge defaults from the file's roles and channel lists (8.1 Permissions). */
  private defaultCan(sp: Space, ch: Channel, role: string, perm: ChannelPermission): boolean {
    const can = new Set(sp.henge.governance.roles[role]?.can ?? []);
    const admin = can.has('edit_any');
    switch (perm) {
      case 'view':
        return ch.read ? ch.read.includes(role) || admin || can.has('moderate') : true;
      case 'send':
        if (ch.post) return ch.post.includes(role);
        if (ch.type === 'announcement') return admin || can.has('manage_channels');
        if (ch.type === 'agent_run') return role === 'agent';
        return admin || can.has('chat') || can.has('chat_via_api') || can.has('manage_channels') || can.has('moderate');
      case 'threads':
        return admin || can.has('start_threads') || can.has('manage_channels') || can.has('moderate');
      case 'mention_everyone':
        return (sp.henge.community?.defaults?.mentions_everyone ?? []).includes(role);
      case 'react':
        return admin || can.has('react') || can.has('manage_channels') || can.has('moderate');
      case 'manage':
        return admin || can.has('moderate') || can.has('pin');
      case 'api':
        return admin || can.has('chat_via_api');
    }
  }

  can(hengeId: string, channelId: string, role: string, perm: ChannelPermission): boolean {
    const sp = this.spaces.get(hengeId);
    const ch = sp?.channels.find((c) => c.id === channelId);
    if (!sp || !ch) return false;
    const o = sp.overrides[channelId]?.[perm]?.[role];
    if (o === 'allow') return true;
    if (o === 'deny') return false;
    return this.defaultCan(sp, ch, role, perm);
  }

  private myCan(sp: Space, hengeId: string, channelId: string, perm: ChannelPermission) {
    return this.can(hengeId, channelId, sp.myRole, perm);
  }

  private meId() {
    return this.profile?.id ?? 'local:you';
  }

  /* Messages */

  messages(hengeId: string, channelId: string) {
    return [...this.msgs.values()].filter((m) => m.hengeId === hengeId && m.channelId === channelId && !m.threadRoot).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  thread(rootId: string) {
    return [...this.msgs.values()].filter((m) => m.threadRoot === rootId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  message(id: string) {
    return this.msgs.get(id) ?? null;
  }

  async send(hengeId: string, channelId: string, body: string, opts: { threadRoot?: string; replyTo?: string } = {}): Promise<Result<Message>> {
    const sp = this.spaces.get(hengeId);
    const ch = sp?.channels.find((c) => c.id === channelId);
    if (!sp || !ch) return no('That channel does not exist.');
    if (!this.profile) return no('Set up your profile to chat.');
    const text = body.trim();
    if (!text) return no('Write a message first.');
    if (text.length > 4000) return no('Messages are limited to 4000 characters.');
    const me = this.meId();
    const until = sp.timeouts[me];
    if (until && until > this.now()) return no('You are timed out in this Henge.', Math.ceil((until - this.now()) / 1000));
    if (opts.threadRoot) {
      if (!this.msgs.get(opts.threadRoot)) return no('That thread does not exist.');
      if (!this.myCan(sp, hengeId, channelId, 'send') && !this.myCan(sp, hengeId, channelId, 'threads')) return no('You cannot reply in this channel.');
    } else if (!this.myCan(sp, hengeId, channelId, 'send')) return no(ch.type === 'agent_run' ? 'Only agents post here. You can reply in threads.' : 'Your role cannot post in this channel.');
    const mentions = mentionsIn(text);
    if (mentions.some((m) => m === 'everyone' || m === 'here') && !this.myCan(sp, hengeId, channelId, 'mention_everyone')) return no('Your role cannot mention everyone here.');
    const now = this.now();
    const key = `${me}:${channelId}`;
    const recent = (sp.lastSent[key] ?? []).filter((t) => now - t < 60_000);
    if (ch.slowModeS > 0 && !opts.threadRoot && recent.length) {
      const wait = Math.ceil((recent[recent.length - 1]! + ch.slowModeS * 1000 - now) / 1000);
      if (wait > 0) return no(`Slow mode is on. You can send again in ${wait} s.`, wait);
    }
    const perMinute = sp.henge.community?.defaults?.rate_limits?.['human_messages_per_minute'];
    if (perMinute && recent.length >= perMinute) return no('You are sending quickly. Wait a moment.', Math.ceil((recent[0]! + 60_000 - now) / 1000));
    sp.lastSent[key] = [...recent, now];
    const m: Message = {
      id: this.id('msg'),
      hengeId,
      channelId,
      authorId: me,
      authorType: 'human',
      authorName: this.profile.displayName,
      body: text,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      replyTo: opts.replyTo ?? null,
      threadRoot: opts.threadRoot ?? null,
      reactions: {},
      pinned: false,
      mentions,
    };
    this.msgs.set(m.id, m);
    sp.lastRead[channelId] = now;
    sp.typing[channelId]?.delete(me);
    this.changed();
    return ok(m);
  }

  async edit(messageId: string, body: string): Promise<Result> {
    const m = this.msgs.get(messageId);
    if (!m || m.deletedAt) return no('That message is gone.');
    if (m.authorId !== this.meId()) return no('You can only edit your own messages.');
    const text = body.trim();
    if (!text) return no('Write a message first.');
    this.msgs.set(m.id, { ...m, body: text, editedAt: this.now(), mentions: mentionsIn(text) });
    this.changed();
    return okVoid;
  }

  private audit(sp: Space, hengeId: string, e: Omit<AuditEntry, 'id' | 'hengeId' | 'createdAt' | 'actorId' | 'actorName' | 'actorType'> & Partial<Pick<AuditEntry, 'actorId' | 'actorName' | 'actorType'>>) {
    const p = this.profile;
    sp.audit.unshift({ id: this.id('aud'), hengeId, createdAt: this.now(), actorId: e.actorId ?? this.meId(), actorName: e.actorName ?? p?.handle ?? 'you', actorType: e.actorType ?? 'human', action: e.action, target: e.target, reason: e.reason });
  }

  async remove(messageId: string, reason = ''): Promise<Result> {
    const m = this.msgs.get(messageId);
    const sp = m && this.spaces.get(m.hengeId);
    if (!m || !sp || m.deletedAt) return no('That message is gone.');
    const own = m.authorId === this.meId();
    if (!own && !this.myCan(sp, m.hengeId, m.channelId, 'manage')) return no('Your role cannot delete messages by others.');
    // Soft delete: kept as evidence (8.2), shown as removed.
    this.msgs.set(m.id, { ...m, deletedAt: this.now() });
    if (!own) this.audit(sp, m.hengeId, { action: 'delete_message', target: m.authorName, reason: reason || 'No reason given.' });
    this.changed();
    return okVoid;
  }

  async react(messageId: string, emoji: string): Promise<Result> {
    const m = this.msgs.get(messageId);
    const sp = m && this.spaces.get(m.hengeId);
    if (!m || !sp || m.deletedAt) return no('That message is gone.');
    if (!this.myCan(sp, m.hengeId, m.channelId, 'react')) return no('Your role cannot react here.');
    if (!/^\p{Extended_Pictographic}/u.test(emoji)) return no('Reactions are emoji only.');
    const me = this.meId();
    const who = new Set(m.reactions[emoji] ?? []);
    if (who.has(me)) who.delete(me);
    else who.add(me);
    const reactions = { ...m.reactions, [emoji]: [...who] };
    if (!who.size) delete reactions[emoji];
    this.msgs.set(m.id, { ...m, reactions });
    this.changed();
    return okVoid;
  }

  async pin(messageId: string): Promise<Result> {
    const m = this.msgs.get(messageId);
    const sp = m && this.spaces.get(m.hengeId);
    if (!m || !sp || m.deletedAt) return no('That message is gone.');
    if (!this.myCan(sp, m.hengeId, m.channelId, 'manage')) return no('Your role cannot pin messages.');
    this.msgs.set(m.id, { ...m, pinned: !m.pinned });
    if (!m.pinned) this.audit(sp, m.hengeId, { action: 'pin', target: `#${m.channelId}`, reason: m.body.slice(0, 140) });
    this.changed();
    return okVoid;
  }

  pins(hengeId: string, channelId: string) {
    return this.messages(hengeId, channelId).filter((m) => m.pinned && !m.deletedAt);
  }

  /* Unread and typing */

  unread(hengeId: string, channelId: string) {
    const sp = this.spaces.get(hengeId);
    if (!sp) return { count: 0, mentions: 0 };
    const since = sp.lastRead[channelId] ?? 0;
    const me = this.meId();
    const handle = this.profile?.handle;
    let count = 0;
    let mentions = 0;
    for (const m of this.msgs.values()) {
      if (m.hengeId !== hengeId || m.channelId !== channelId || m.authorId === me || m.deletedAt || m.createdAt <= since) continue;
      count++;
      if (m.mentions.some((x) => x === handle || x === 'everyone' || x === 'here')) mentions++;
    }
    return { count, mentions };
  }

  hengeUnread(hengeId: string) {
    return this.channels(hengeId).reduce(
      (acc, c) => {
        const u = this.unread(hengeId, c.id);
        return { count: acc.count + u.count, mentions: acc.mentions + u.mentions };
      },
      { count: 0, mentions: 0 },
    );
  }

  markRead(hengeId: string, channelId: string) {
    const sp = this.spaces.get(hengeId);
    if (!sp) return;
    const u = this.unread(hengeId, channelId);
    sp.lastRead[channelId] = this.now();
    if (u.count) this.changed();
  }

  typing(hengeId: string, channelId: string) {
    const me = this.meId();
    const names = [...(this.spaces.get(hengeId)?.typing[channelId] ?? [])].filter((id) => id !== me);
    return names.map((id) => this.profileOf(id)?.displayName ?? id);
  }

  setTyping(hengeId: string, channelId: string, on: boolean) {
    const sp = this.spaces.get(hengeId);
    if (!sp) return;
    const set = (sp.typing[channelId] ??= new Set());
    const me = this.meId();
    if (on === set.has(me)) return;
    if (on) set.add(me);
    else set.delete(me);
    this.changed();
  }

  /* Proposals */

  async openProposal(input: { hengeId: string; channelId: string; glyphId: string; title: string; body: string; changes: Record<string, unknown> }): Promise<Result<Proposal>> {
    const sp = this.spaces.get(input.hengeId);
    if (!sp) return no('That Henge is not open.');
    if (!this.profile) return no('Set up your profile to open a proposal.');
    const channel = sp.channels.find((c) => c.id === input.channelId) ? input.channelId : sp.channels.find((c) => c.glyphPosts.includes('governance'))?.id ?? sp.channels[0]?.id;
    if (!channel) return no('This Henge has no channel for proposals.');
    const p: Proposal = {
      id: this.id('prp'),
      number: sp.proposals.length + 1,
      hengeId: input.hengeId,
      glyphId: input.glyphId,
      title: input.title,
      body: input.body,
      changes: input.changes,
      status: 'open',
      votes: {},
      openedBy: this.profile.handle,
      createdAt: this.now(),
    };
    sp.proposals.push(p);
    const m: Message = {
      id: this.id('msg'),
      hengeId: input.hengeId,
      channelId: channel,
      authorId: 'glyph:verafy/governance',
      authorType: 'glyph',
      authorName: 'Governance Glyph',
      body: `${this.profile.handle} opened a proposal.`,
      createdAt: this.now(),
      editedAt: null,
      deletedAt: null,
      replyTo: null,
      threadRoot: null,
      reactions: {},
      pinned: false,
      proposal: { proposalId: p.id },
      mentions: [],
    };
    this.msgs.set(m.id, m);
    this.changed();
    return ok(p);
  }

  proposal(id: string) {
    for (const sp of this.spaces.values()) {
      const p = sp.proposals.find((x) => x.id === id);
      if (p) return p;
    }
    return null;
  }
  proposals(hengeId: string) {
    return this.spaces.get(hengeId)?.proposals ?? [];
  }

  /** Records your vote. Tallying and closing belong to the Governance Glyph runtime, not this store. */
  async vote(proposalId: string, choice: 'yes' | 'no'): Promise<Result> {
    const p = this.proposal(proposalId);
    if (!p) return no('That proposal does not exist.');
    if (p.status !== 'open') return no('Voting has closed.');
    p.votes = { ...p.votes, [this.meId()]: choice };
    this.changed();
    return okVoid;
  }

  /* Moderation */

  private isMod(sp: Space) {
    const can = sp.henge.governance.roles[sp.myRole]?.can ?? [];
    return can.includes('moderate') || can.includes('edit_any');
  }

  async report(messageId: string, reason: ReportReason): Promise<Result<Report>> {
    const m = this.msgs.get(messageId);
    const sp = m && this.spaces.get(m.hengeId);
    if (!m || !sp) return no('That message is gone.');
    const me = this.meId();
    if (sp.reports.some((r) => r.messageId === messageId && r.reporterId === me)) return no('You already reported this message.');
    const r: Report = {
      id: this.id('rep'),
      hengeId: m.hengeId,
      messageId,
      snapshot: { authorId: m.authorId, authorName: m.authorName, body: m.body, channelId: m.channelId },
      reason,
      reporterId: me,
      createdAt: this.now(),
      status: 'open',
      outcome: null,
    };
    sp.reports.unshift(r);
    this.autoTimeout(sp, m.hengeId, m.authorId, m.authorName);
    this.changed();
    return ok(r);
  }

  /** Moderation Glyph Runes: N reports about one author within M minutes times them out (7.1, 8.2). */
  private autoTimeout(sp: Space, hengeId: string, authorId: string, authorName: string) {
    const entry = (sp.henge.glyphs ?? []).find((g) => g.use.startsWith('verafy/moderation@'));
    const runes = entry?.runes ?? {};
    const n = runes['auto_timeout.reports'];
    const win = runes['auto_timeout.window_minutes'];
    const dur = runes['auto_timeout.duration_minutes'];
    if (typeof n !== 'number' || typeof win !== 'number' || typeof dur !== 'number') return;
    const since = this.now() - win * 60_000;
    const count = sp.reports.filter((r) => r.snapshot.authorId === authorId && r.createdAt >= since && r.status === 'open').length;
    if (count < n || (sp.timeouts[authorId] ?? 0) > this.now()) return;
    sp.timeouts[authorId] = this.now() + dur * 60_000;
    this.audit(sp, hengeId, { actorId: 'glyph:verafy/moderation', actorName: 'Moderation Glyph', actorType: 'glyph', action: 'timeout', target: authorName, reason: `Rune: ${n} reports in ${win} minutes. Timeout ${dur} minutes.` });
  }

  reports(hengeId: string) {
    return this.spaces.get(hengeId)?.reports ?? [];
  }

  async resolveReport(reportId: string, action: 'dismiss' | 'delete' | 'timeout' | 'kick' | 'ban'): Promise<Result> {
    for (const [hengeId, sp] of this.spaces) {
      const r = sp.reports.find((x) => x.id === reportId);
      if (!r) continue;
      if (!this.isMod(sp)) return no('Only moderators can act on reports.');
      if (action === 'dismiss') {
        r.status = 'dismissed';
        r.outcome = 'Dismissed by a moderator.';
        this.audit(sp, hengeId, { action: 'report_dismissed', target: r.snapshot.authorName, reason: `Report: ${r.reason}.` });
      } else {
        const res = action === 'delete' ? await this.remove(r.messageId, `Report: ${r.reason}.`) : await this.moderate(hengeId, { kind: action, targetId: r.snapshot.authorId, minutes: 60, reason: `Report: ${r.reason}.` });
        if (!res.ok) return res;
        r.status = 'actioned';
        r.outcome = `A moderator took action: ${action}.`;
      }
      this.changed();
      return okVoid;
    }
    return no('That report does not exist.');
  }

  async moderate(hengeId: string, a: { kind: 'timeout' | 'kick' | 'ban' | 'revoke_token' | 'bulk_delete'; targetId: string; minutes?: number; reason: string }): Promise<Result> {
    const sp = this.spaces.get(hengeId);
    if (!sp) return no('That Henge is not open.');
    if (!this.isMod(sp)) return no('Only moderators can do that.');
    if (a.targetId === this.meId()) return no('You cannot moderate yourself.');
    const target = sp.members.find((m) => m.id === a.targetId);
    const name = target?.handle ?? [...this.msgs.values()].find((m) => m.authorId === a.targetId)?.authorName ?? a.targetId;
    const reason = a.reason.trim() || 'No reason given.';
    switch (a.kind) {
      case 'timeout':
        sp.timeouts[a.targetId] = this.now() + (a.minutes ?? 60) * 60_000;
        this.audit(sp, hengeId, { action: 'timeout', target: name, reason: `${reason} Timeout ${a.minutes ?? 60} minutes.` });
        break;
      case 'kick':
        sp.members = sp.members.filter((m) => m.id !== a.targetId);
        this.audit(sp, hengeId, { action: 'kick', target: name, reason });
        break;
      case 'ban':
        sp.members = sp.members.filter((m) => m.id !== a.targetId && m.ownerHandle !== target?.handle);
        sp.bans.unshift({ targetId: a.targetId, targetName: name, reason, at: this.now() });
        this.audit(sp, hengeId, { action: 'ban', target: name, reason });
        break;
      case 'revoke_token':
        if (target && target.actorType !== 'agent') return no('Only agents have API tokens.');
        this.audit(sp, hengeId, { action: 'revoke_token', target: name, reason });
        break;
      case 'bulk_delete': {
        const since = this.now() - 60 * 60_000;
        let n = 0;
        for (const m of this.msgs.values())
          if (m.hengeId === hengeId && m.authorId === a.targetId && !m.deletedAt && m.createdAt >= since) {
            this.msgs.set(m.id, { ...m, deletedAt: this.now() });
            n++;
          }
        this.audit(sp, hengeId, { action: 'bulk_delete', target: name, reason: `${reason} ${n} ${n === 1 ? 'message' : 'messages'} from the last hour.` });
        break;
      }
    }
    this.changed();
    return okVoid;
  }

  channelPerms(hengeId: string, channelId: string): ChannelPerms {
    const sp = this.spaces.get(hengeId);
    const roles = sp ? Object.keys(sp.henge.governance.roles) : [];
    const out = {} as ChannelPerms;
    for (const p of CHANNEL_PERMISSIONS) {
      out[p.key] = {};
      for (const r of roles) out[p.key][r] = sp?.overrides[channelId]?.[p.key]?.[r] ?? 'inherit';
    }
    return out;
  }

  async saveChannelSettings(hengeId: string, channelId: string, s: { type: ChannelType; categoryId: string; slowModeS: number; perms: ChannelPerms }): Promise<Result> {
    const sp = this.spaces.get(hengeId);
    const ch = sp?.channels.find((c) => c.id === channelId);
    if (!sp || !ch) return no('That channel does not exist.');
    const can = sp.henge.governance.roles[sp.myRole]?.can ?? [];
    if (!can.includes('manage_channels') && !can.includes('edit_any')) return no('Your role cannot change channel settings.');
    if (!Number.isInteger(s.slowModeS) || s.slowModeS < 0 || s.slowModeS > 21_600) return no('Slow mode must be 0 to 21600 seconds.');
    const cat = sp.channels.find((c) => c.categoryId === s.categoryId);
    if (s.slowModeS !== ch.slowModeS) this.audit(sp, hengeId, { action: 'slow_mode', target: `#${ch.id}`, reason: s.slowModeS ? `${s.slowModeS} seconds.` : 'Off.' });
    sp.channels = sp.channels.map((c) => (c.id === channelId ? { ...c, type: s.type, slowModeS: s.slowModeS, categoryId: s.categoryId, categoryName: cat?.categoryName ?? c.categoryName } : c));
    const before = JSON.stringify(sp.overrides[channelId] ?? {});
    sp.overrides[channelId] = s.perms;
    if (before !== JSON.stringify(s.perms)) this.audit(sp, hengeId, { action: 'channel_settings', target: `#${ch.id}`, reason: 'Permissions changed.' });
    this.changed();
    return okVoid;
  }

  auditLog(hengeId: string) {
    return this.spaces.get(hengeId)?.audit ?? [];
  }
  bans(hengeId: string) {
    return this.spaces.get(hengeId)?.bans ?? [];
  }
}
