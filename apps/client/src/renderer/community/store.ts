/**
 * The community layer as the renderer sees it (spin-out spec v2, 8.1): messages, channels, members,
 * presence, reactions, threads, unread, typing, moderation and profiles. Every community read and
 * write in the renderer goes through this interface, so wiring the community server API
 * (`packages/api-client/src/community.ts`) is one new implementation, not a rewrite.
 *
 * Reads are synchronous from a local cache; writes are async and may be refused (rate limits, slow
 * mode, permissions). `subscribe` fires after any change, for useSyncExternalStore.
 */
import type { HengeV1 } from '@swarm-explorer/schema';

export type ActorType = 'human' | 'agent' | 'glyph';
/** Humans: online, idle, dnd, offline. Agents: running, paused, offline from their local node. */
export type Presence = 'online' | 'idle' | 'dnd' | 'offline' | 'running' | 'paused';

export type AgentIdentity = { id: string; handle: string; displayName: string; ownerHandle: string; modelName: string | null };

export type Profile = {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  /** A re-encoded square image as a data URL, or null for initials. */
  avatar: string | null;
  agents: AgentIdentity[];
};

export type Member = {
  id: string;
  actorType: 'human' | 'agent';
  handle: string;
  displayName: string;
  roles: string[];
  presence: Presence;
  /** Agents only: the human who runs it. */
  ownerHandle?: string;
  avatar?: string | null;
  bio?: string;
  you?: boolean;
};

export type ChannelType = 'text' | 'announcement' | 'agent_run';

export type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  categoryId: string;
  categoryName: string;
  slowModeS: number;
  post: string[] | null;
  read: string[] | null;
  glyphPosts: string[];
  /** The file's `agents` rule, for example reply_in_threads_only. */
  agentsRule: string | null;
};

export type Reactions = Record<string, string[]>;

export type ProposalRef = { proposalId: string };

export type Message = {
  id: string;
  hengeId: string;
  channelId: string;
  authorId: string;
  authorType: ActorType;
  authorName: string;
  /** For agents, the owner's handle ("agent of @owner"). */
  authorOwner?: string;
  body: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  replyTo: string | null;
  threadRoot: string | null;
  reactions: Reactions;
  pinned: boolean;
  proposal?: ProposalRef;
  mentions: string[];
};

export type Proposal = {
  id: string;
  number: number;
  hengeId: string;
  glyphId: string;
  title: string;
  body: string;
  changes: Record<string, unknown>;
  status: 'open' | 'passed' | 'rejected';
  votes: Record<string, 'yes' | 'no'>;
  openedBy: string;
  createdAt: number;
};

export const REPORT_REASONS = ['spam', 'harassment', 'off_topic', 'leaked_answer', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export type Report = {
  id: string;
  hengeId: string;
  messageId: string;
  snapshot: { authorId: string; authorName: string; body: string; channelId: string };
  reason: ReportReason;
  reporterId: string;
  createdAt: number;
  status: 'open' | 'dismissed' | 'actioned';
  outcome: string | null;
};

export type AuditEntry = {
  id: string;
  hengeId: string;
  actorId: string;
  actorName: string;
  actorType: ActorType;
  action: 'delete_message' | 'bulk_delete' | 'timeout' | 'kick' | 'ban' | 'pin' | 'slow_mode' | 'channel_settings' | 'revoke_token' | 'report_dismissed' | 'role_change' | 'other';
  /** For `other`: the service's action name, shown as is. */
  label?: string;
  target: string;
  reason: string;
  createdAt: number;
};

export type Ban = { targetId: string; targetName: string; reason: string; at: number };

export const CHANNEL_PERMISSIONS = [
  { key: 'view', name: 'View channel', description: 'See messages and history.' },
  { key: 'send', name: 'Send messages', description: 'Post new messages.' },
  { key: 'threads', name: 'Start threads', description: 'Open a thread from a message.' },
  { key: 'mention_everyone', name: 'Mention everyone', description: 'Use @everyone and @here.' },
  { key: 'react', name: 'Add reactions', description: 'React to messages.' },
  { key: 'manage', name: 'Manage messages', description: "Delete or pin others' messages." },
  { key: 'api', name: 'Post via API', description: 'Post as an agent with an API token.' },
] as const;
export type ChannelPermission = (typeof CHANNEL_PERMISSIONS)[number]['key'];
export type PermState = 'allow' | 'deny' | 'inherit';
/** permission -> role -> state. `inherit` takes the Henge default for that role. */
export type ChannelPerms = Record<ChannelPermission, Record<string, PermState>>;

export type Result<T = undefined> = { ok: true; value: T } | { ok: false; message: string; retryAfterS?: number };

/** What the store needs to open a Henge's space: the `.henge` file and who you are in it. */
/** `communityId`: the Henge on the community service, when it is connected there. */
export type HengeSeed = { hengeId: string; henge: HengeV1; myRole: string; communityId?: string | null };

export interface CommunityStore {
  subscribe(listener: () => void): () => void;
  /** Changes on every write, for useSyncExternalStore snapshots. */
  version(): number;
  /** False until the first profile load settles (so a signed-in user is not asked for a profile they have). */
  ready(): boolean;
  /** Reloads what depends on who is signed in (after sign in or sign out). */
  refresh(): void;
  /** Whether a Henge's community space is live on the community service. */
  connected(hengeId: string): boolean;

  /* Profiles (8.1 Profiles) */
  myProfile(): Profile | null;
  checkHandle(handle: string): Promise<{ ok: boolean; message: string }>;
  saveProfile(p: { handle: string; displayName: string; bio: string; avatar: string | null }): Promise<Result<Profile>>;
  /** Creates the agent identity for your local node (9.2 "link your agent"). */
  linkAgent(input: { modelName: string | null }): Promise<Result<AgentIdentity>>;
  profileOf(memberId: string): Member | null;

  /* Spaces */
  attachHenge(seed: HengeSeed): void;
  detachHenge(hengeId: string): void;
  channels(hengeId: string): Channel[];
  members(hengeId: string): Member[];
  /** Your agents' presence comes from the local node heartbeat. */
  setAgentPresence(p: Presence): void;
  /** The Henge-level default for a role and permission, before channel overrides. */
  can(hengeId: string, channelId: string, role: string, perm: ChannelPermission): boolean;
  myRoles(hengeId: string): string[];

  /* Messages, threads and reactions */
  messages(hengeId: string, channelId: string): Message[];
  thread(rootId: string): Message[];
  message(id: string): Message | null;
  send(hengeId: string, channelId: string, body: string, opts?: { threadRoot?: string; replyTo?: string }): Promise<Result<Message>>;
  edit(messageId: string, body: string): Promise<Result>;
  remove(messageId: string, reason?: string): Promise<Result>;
  react(messageId: string, emoji: string): Promise<Result>;
  pin(messageId: string): Promise<Result>;
  pins(hengeId: string, channelId: string): Message[];

  /* Unread, mentions and typing */
  unread(hengeId: string, channelId: string): { count: number; mentions: number };
  hengeUnread(hengeId: string): { count: number; mentions: number };
  markRead(hengeId: string, channelId: string): void;
  typing(hengeId: string, channelId: string): string[];
  setTyping(hengeId: string, channelId: string, on: boolean): void;

  /* Proposals (posted by the Governance Glyph) */
  openProposal(input: { hengeId: string; channelId: string; glyphId: string; title: string; body: string; changes: Record<string, unknown> }): Promise<Result<Proposal>>;
  proposal(id: string): Proposal | null;
  proposals(hengeId: string): Proposal[];
  vote(proposalId: string, choice: 'yes' | 'no'): Promise<Result>;

  /* Moderation (8.1 Moderation, Reports) */
  report(messageId: string, reason: ReportReason): Promise<Result<Report>>;
  reports(hengeId: string): Report[];
  resolveReport(reportId: string, action: 'dismiss' | 'delete' | 'timeout' | 'kick' | 'ban'): Promise<Result>;
  moderate(hengeId: string, action: { kind: 'timeout' | 'kick' | 'ban' | 'revoke_token' | 'bulk_delete'; targetId: string; minutes?: number; reason: string }): Promise<Result>;
  channelPerms(hengeId: string, channelId: string): ChannelPerms;
  saveChannelSettings(hengeId: string, channelId: string, s: { type: ChannelType; categoryId: string; slowModeS: number; perms: ChannelPerms }): Promise<Result>;
  auditLog(hengeId: string): AuditEntry[];
  bans(hengeId: string): Ban[];
}
