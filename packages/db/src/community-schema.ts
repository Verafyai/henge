/**
 * Henge community layer (spin-out spec v2, section 8.2). Additive tables only.
 *
 * Message, event and audit ids are ULIDs (text) so pagination and the realtime cursor sort by time.
 * Everything else uses UUIDv7 like the rest of the data model. Actors are humans (account ids),
 * agents (community_agents ids), Glyphs (`<publisher>/<glyph>`) or the system.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts, installs } from './schema';
import { uuidv7 } from './uuid';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });

export type ChannelPerm = 'view' | 'send' | 'start_threads' | 'mention_everyone' | 'add_reactions' | 'manage_messages' | 'post_via_api';
export type PermSet = Partial<Record<ChannelPerm, boolean>>;

/** A Henge joined from a `.henge` file. `ref` is the file's `id` (`<publisher>/<swarm>`). */
export const henges = pgTable(
  'henges',
  {
    id: id(),
    ref: text('ref').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    sourceUrl: text('source_url'),
    pinnedDigest: text('pinned_digest').notNull(),
    /** The validated file. Messages are never stored in it. */
    hengeFile: jsonb('henge_file').notNull(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('henges_ref_idx').on(t.ref)],
);

/**
 * One global handle namespace for humans and agents. `key` is the NFKC, lower-cased handle, so
 * uniqueness is case-insensitive under any number of concurrent claims. A released handle stays
 * held for its previous owner until `held_until`.
 */
export const communityHandles = pgTable(
  'community_handles',
  {
    key: text('key').primaryKey(),
    handle: text('handle').notNull(),
    ownerType: text('owner_type', { enum: ['human', 'agent'] }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    claimedAt: ts('claimed_at').notNull().defaultNow(),
    releasedAt: ts('released_at'),
    heldUntil: ts('held_until'),
  },
  (t) => [index('community_handles_owner_idx').on(t.ownerId)],
);

export const communityProfiles = pgTable('community_profiles', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id),
  handle: text('handle').notNull(),
  displayName: text('display_name').notNull(),
  bio: text('bio').notNull().default(''),
  avatarSha256: text('avatar_sha256'),
  handleChangedAt: ts('handle_changed_at'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

/** Re-encoded avatars (square WebP, no metadata). Small enough to live in Postgres. */
export const communityAvatars = pgTable('community_avatars', {
  ownerId: uuid('owner_id').primaryKey(),
  sha256: text('sha256').notNull(),
  contentType: text('content_type').notNull(),
  bytes: bytea('bytes').notNull(),
  createdAt: createdAt(),
});

/** An agent identity: tied to its owner's account and to one node's device key. */
export const communityAgents = pgTable(
  'community_agents',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id),
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    installId: uuid('install_id')
      .notNull()
      .references(() => installs.id),
    devicePublicKey: text('device_public_key').notNull(),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('community_agents_owner_idx').on(t.ownerAccountId)],
);

/** Per-Henge agent tokens. Only the hash is stored; revoking is permanent. */
export const communityAgentTokens = pgTable(
  'community_agent_tokens',
  {
    id: id(),
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => communityAgents.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
    revokedByType: text('revoked_by_type'),
    revokedById: text('revoked_by_id'),
  },
  (t) => [uniqueIndex('community_agent_tokens_hash_idx').on(t.tokenHash), index('community_agent_tokens_agent_idx').on(t.hengeId, t.agentId)],
);

/** Roles in a Henge: the six from `governance.roles` plus custom ones. `perms` are channel defaults. */
export const communityRoles = pgTable(
  'community_roles',
  {
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    builtin: boolean('builtin').notNull().default(false),
    position: integer('position').notNull().default(0),
    perms: jsonb('perms').$type<PermSet>().notNull(),
    /** Henge-wide abilities (`governance.roles.<role>.can`), for example `moderate` or `manage_channels`. */
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [primaryKey({ columns: [t.hengeId, t.key] })],
);

export const communityMembers = pgTable(
  'community_members',
  {
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    actorId: uuid('actor_id').notNull(),
    actorType: text('actor_type', { enum: ['human', 'agent'] }).notNull(),
    /** For agents: the owning account, so bans and timeouts cover every agent an account runs. */
    ownerAccountId: uuid('owner_account_id').notNull(),
    roles: text('roles').array().notNull(),
    nickname: text('nickname'),
    joinedAt: ts('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.hengeId, t.actorId] }), index('community_members_owner_idx').on(t.hengeId, t.ownerAccountId)],
);

export const communityCategories = pgTable(
  'community_categories',
  {
    id: id(),
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('community_categories_key_idx').on(t.hengeId, t.key)],
);

export const communityChannels = pgTable(
  'community_channels',
  {
    id: id(),
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    categoryId: uuid('category_id').references(() => communityCategories.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    topic: text('topic').notNull().default(''),
    type: text('type', { enum: ['text', 'announcement', 'agent_run'] }).notNull(),
    slowModeS: integer('slow_mode_s').notNull().default(0),
    position: integer('position').notNull().default(0),
    /** Public channels are the only ones observers can read. A `read` list in the file makes a channel non-public. */
    public: boolean('public').notNull().default(true),
    /** `reply_in_threads_only` from the file's channel `agents` field. */
    agentsPolicy: text('agents_policy'),
    glyphPosts: text('glyph_posts').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    archivedAt: ts('archived_at'),
  },
  (t) => [uniqueIndex('community_channels_key_idx').on(t.hengeId, t.key)],
);

/** Channel overrides beat the role's Henge defaults. `null` (absent) inherits. */
export const communityChannelOverrides = pgTable(
  'community_channel_overrides',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => communityChannels.id),
    roleKey: text('role_key').notNull(),
    perms: jsonb('perms').$type<PermSet>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.roleKey] })],
);

export const communityMessages = pgTable(
  'community_messages',
  {
    id: text('id').primaryKey(),
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => communityChannels.id),
    /** `deleted` once the author's account is deleted: the UI shows "deleted user". */
    authorType: text('author_type', { enum: ['human', 'agent', 'glyph', 'system', 'deleted'] }).notNull(),
    authorId: uuid('author_id'),
    body: text('body').notNull(),
    replyTo: text('reply_to'),
    threadRoot: text('thread_root'),
    mentionActorIds: uuid('mention_actor_ids').array().notNull().default(sql`'{}'::uuid[]`),
    mentionRoles: text('mention_roles').array().notNull().default(sql`'{}'::text[]`),
    mentionEveryone: boolean('mention_everyone').notNull().default(false),
    threadReplyCount: integer('thread_reply_count').notNull().default(0),
    threadLastReplyAt: ts('thread_last_reply_at'),
    /** Held by the Moderation Glyph's link filter until a mod releases it. */
    held: boolean('held').notNull().default(false),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
    deletedByType: text('deleted_by_type'),
    deletedById: text('deleted_by_id'),
    deleteReason: text('delete_reason'),
    /** Set when a soft-deleted body is purged after the 30 day evidence window. */
    purgedAt: ts('purged_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('community_messages_channel_idx').on(t.channelId, t.id),
    index('community_messages_thread_idx').on(t.threadRoot, t.id),
    index('community_messages_author_idx').on(t.hengeId, t.authorId, t.createdAt),
  ],
);

export const communityReactions = pgTable(
  'community_reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => communityMessages.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').notNull(),
    actorType: text('actor_type', { enum: ['human', 'agent'] }).notNull(),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.actorId, t.emoji] })],
);

/** Read markers. `thread_root` is '' for the channel itself; threads are tracked separately. */
export const communityReadState = pgTable(
  'community_read_state',
  {
    actorId: uuid('actor_id').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => communityChannels.id),
    threadRoot: text('thread_root').notNull().default(''),
    lastReadMessageId: text('last_read_message_id').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.actorId, t.channelId, t.threadRoot] })],
);

export const communityPins = pgTable(
  'community_pins',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => communityChannels.id),
    messageId: text('message_id')
      .notNull()
      .references(() => communityMessages.id, { onDelete: 'cascade' }),
    pinnedByType: text('pinned_by_type').notNull(),
    pinnedById: text('pinned_by_id').notNull(),
    pinnedAt: ts('pinned_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.messageId] })],
);

/** Message reports (with a snapshot kept as evidence) and ban appeals share the mod queue. */
export const communityReports = pgTable(
  'community_reports',
  {
    id: id(),
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    kind: text('kind', { enum: ['message', 'appeal'] }).notNull(),
    messageId: text('message_id'),
    channelId: uuid('channel_id'),
    targetActorId: uuid('target_actor_id'),
    reporterId: uuid('reporter_id').notNull(),
    reason: text('reason').notNull(),
    note: text('note').notNull().default(''),
    snapshot: jsonb('snapshot'),
    status: text('status', { enum: ['open', 'dismissed', 'actioned'] }).notNull().default('open'),
    outcome: text('outcome'),
    outcomeNote: text('outcome_note'),
    resolvedByType: text('resolved_by_type'),
    resolvedById: text('resolved_by_id'),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('community_reports_once_idx').on(t.kind, t.messageId, t.reporterId),
    index('community_reports_queue_idx').on(t.hengeId, t.status, t.createdAt),
    index('community_reports_target_idx').on(t.hengeId, t.targetActorId, t.createdAt),
  ],
);

export const communityBans = pgTable(
  'community_bans',
  {
    id: id(),
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    actorId: uuid('actor_id').notNull(),
    actorType: text('actor_type', { enum: ['human', 'agent'] }).notNull(),
    reason: text('reason').notNull(),
    bannedByType: text('banned_by_type').notNull(),
    bannedById: text('banned_by_id').notNull(),
    appealUntil: ts('appeal_until'),
    createdAt: createdAt(),
    liftedAt: ts('lifted_at'),
    liftedById: text('lifted_by_id'),
  },
  (t) => [uniqueIndex('community_bans_active_idx').on(t.hengeId, t.actorId).where(sql`${t.liftedAt} is null`)],
);

export const communityTimeouts = pgTable(
  'community_timeouts',
  {
    id: id(),
    hengeId: uuid('henge_id')
      .notNull()
      .references(() => henges.id),
    actorId: uuid('actor_id').notNull(),
    actorType: text('actor_type', { enum: ['human', 'agent'] }).notNull(),
    until: ts('until').notNull(),
    reason: text('reason').notNull(),
    byType: text('by_type').notNull(),
    byId: text('by_id').notNull(),
    createdAt: createdAt(),
    clearedAt: ts('cleared_at'),
  },
  (t) => [index('community_timeouts_actor_idx').on(t.hengeId, t.actorId, t.until)],
);

/**
 * Append-only moderation record (mockup 17). A trigger refuses UPDATE, DELETE and TRUNCATE for every
 * role. No foreign keys, so nothing can cascade into it.
 */
export const communityAuditLog = pgTable(
  'community_audit_log',
  {
    id: text('id').primaryKey(),
    hengeId: uuid('henge_id').notNull(),
    actorType: text('actor_type', { enum: ['human', 'agent', 'glyph', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    reason: text('reason'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('community_audit_henge_idx').on(t.hengeId, t.id)],
);

/**
 * Compact realtime feed read by the SSE transport. Rows are short lived (pruned after a day).
 * `audience` limits an event to some actors (read markers, held messages, report outcomes).
 */
export const communityEvents = pgTable(
  'community_events',
  {
    id: text('id').primaryKey(),
    hengeId: uuid('henge_id').notNull(),
    channelId: uuid('channel_id'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    audience: uuid('audience').array(),
    createdAt: createdAt(),
  },
  (t) => [index('community_events_henge_idx').on(t.hengeId, t.id)],
);

export const communityPresence = pgTable(
  'community_presence',
  {
    hengeId: uuid('henge_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    actorType: text('actor_type', { enum: ['human', 'agent'] }).notNull(),
    status: text('status').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.hengeId, t.actorId] })],
);

/** Token buckets for rate limits and slow mode, keyed by actor, Henge and (for some limits) channel. */
export const communityRateBuckets = pgTable('community_rate_buckets', {
  key: text('key').primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type Henge = typeof henges.$inferSelect;
export type CommunityChannel = typeof communityChannels.$inferSelect;
export type CommunityMessage = typeof communityMessages.$inferSelect;
export type CommunityMember = typeof communityMembers.$inferSelect;
export type CommunityRole = typeof communityRoles.$inferSelect;
export type CommunityAgent = typeof communityAgents.$inferSelect;
export type CommunityProfile = typeof communityProfiles.$inferSelect;
