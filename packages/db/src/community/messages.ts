/**
 * Messages, threads, reactions, mentions, pins, read state, typing and presence (spin-out spec 8.1).
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../client';
import {
  communityHandles,
  communityMembers,
  communityMessages,
  communityPins,
  communityPresence,
  communityReactions,
  communityReadState,
  type CommunityChannel,
  type CommunityMessage,
} from '../community-schema';
import {
  activeTimeout,
  actorCards,
  actorIds,
  audit,
  can,
  channelAccess,
  CommunityError,
  deletedCard,
  emit,
  forbidden,
  GLYPH_ACTOR,
  notFound,
  roleMaps,
  type Access,
  type ActorCard,
  type Exec,
} from './context';
import { MESSAGE_MAX_CHARS, moderationGlyph, NEW_ACCOUNT_MS, PRESENCE_TTL_MS, rateLimits } from './config';
import { listChannels, membersWithPerm, presenceOf } from './henges';
import { canPost, type FullPerms } from './perms';
import { rateLimited, takePerMinute, takeSlowMode } from './rate-limit';
import { maybePurge } from './retention';
import { ULID_RE, ulid, ulidFloor } from './ulid';

const invalid = (code: string, message: string, details?: Record<string, unknown>) => new CommunityError(400, code, message, details);
const sqlList = (vals: readonly string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);

/* ---------------------------------------------------------------------------------------------- */
/* Wire format                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

export type ReactionDto = { emoji: string; count: number; me: boolean };
export type MessageDto = {
  id: string;
  henge_id: string;
  channel_id: string;
  author: ActorCard;
  body: string | null;
  reply_to: { id: string; author: ActorCard; excerpt: string | null } | null;
  thread_root: string | null;
  thread: { reply_count: number; last_reply_at: string | null } | null;
  mentions: { actor_ids: string[]; roles: string[]; everyone: boolean };
  reactions: ReactionDto[];
  pinned: boolean;
  held: boolean;
  edited_at: string | null;
  deleted: boolean;
  created_at: string;
};

const excerpt = (m: CommunityMessage | undefined) => (m && !m.deletedAt && m.authorType !== 'deleted' ? m.body.slice(0, 140) : null);

export async function messageDtos(db: Exec, rows: CommunityMessage[], viewerId: string | null): Promise<MessageDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const replyIds = [...new Set(rows.map((r) => r.replyTo).filter((x): x is string => !!x))];
  const replies = replyIds.length ? await db.select().from(communityMessages).where(inArray(communityMessages.id, replyIds)) : [];
  const replyMap = new Map(replies.map((r) => [r.id, r]));
  const cards = await actorCards(db, [...rows, ...replies].map((r) => ({ type: r.authorType, id: r.authorId })));
  const reacts = await db
    .select({
      messageId: communityReactions.messageId,
      emoji: communityReactions.emoji,
      count: sql<number>`count(*)::int`,
      me: viewerId ? sql<boolean>`bool_or(${communityReactions.actorId} = ${viewerId})` : sql<boolean>`false`,
      first: sql<string>`min(${communityReactions.createdAt})`,
    })
    .from(communityReactions)
    .where(inArray(communityReactions.messageId, ids))
    .groupBy(communityReactions.messageId, communityReactions.emoji);
  const byMsg = new Map<string, (ReactionDto & { first: string })[]>();
  for (const r of reacts) {
    const list = byMsg.get(r.messageId) ?? [];
    list.push({ emoji: r.emoji, count: r.count, me: !!r.me, first: String(r.first) });
    byMsg.set(r.messageId, list);
  }
  const pins = new Set((await db.select({ id: communityPins.messageId }).from(communityPins).where(inArray(communityPins.messageId, ids))).map((p) => p.id));
  const card = (m: CommunityMessage) => (m.authorId ? (cards.get(m.authorId) ?? deletedCard(m.authorId)) : deletedCard(null));
  return rows.map((m) => {
    const gone = m.deletedAt !== null || m.authorType === 'deleted';
    const rt = m.replyTo ? replyMap.get(m.replyTo) : undefined;
    return {
      id: m.id,
      henge_id: m.hengeId,
      channel_id: m.channelId,
      author: card(m),
      body: gone ? null : m.body,
      reply_to: m.replyTo ? { id: m.replyTo, author: rt ? card(rt) : deletedCard(null), excerpt: excerpt(rt) } : null,
      thread_root: m.threadRoot,
      thread: m.threadRoot === null && m.threadReplyCount > 0 ? { reply_count: m.threadReplyCount, last_reply_at: m.threadLastReplyAt?.toISOString() ?? null } : null,
      mentions: { actor_ids: m.mentionActorIds, roles: m.mentionRoles, everyone: m.mentionEveryone },
      reactions: (byMsg.get(m.id) ?? []).sort((a, b) => a.first.localeCompare(b.first)).map(({ emoji, count, me }) => ({ emoji, count, me })),
      pinned: pins.has(m.id),
      held: m.held,
      edited_at: m.editedAt?.toISOString() ?? null,
      deleted: gone,
      created_at: m.createdAt.toISOString(),
    };
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* Body, mentions and links                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export function cleanBody(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('body_required', 'Write a message.');
  const body = raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trimEnd();
  if (!body.trim()) throw invalid('body_required', 'Write a message.');
  if ([...body].length > MESSAGE_MAX_CHARS) throw invalid('body_too_long', `Messages are at most ${MESSAGE_MAX_CHARS} characters.`);
  return body;
}

const MENTION_RE = /(^|[^A-Za-z0-9_.@])@([A-Za-z0-9._]{1,24})/g;

export function mentionTokens(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) out.add(m[2]!.toLowerCase().replace(/[.]+$/, ''));
  return [...out];
}

const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|app|dev|xyz|info|gg|ly|me|co|ru|cn|tk|top|link|click|site|online|biz|us|uk|to|cc)\b/i;
export const containsLink = (body: string) => LINK_RE.test(body);

type Mentions = { actorIds: string[]; roles: string[]; everyone: boolean };

/** `@handle` (members of this Henge), `@role`, and `@everyone`/`@here` only with `mention_everyone`. */
async function resolveMentions(db: Exec, acc: Access, body: string, perms: FullPerms, now: Date): Promise<Mentions> {
  const tokens = mentionTokens(body);
  if (!tokens.length) return { actorIds: [], roles: [], everyone: false };
  const { rows: roleRows } = await roleMaps(db, acc.henge.id);
  const roleKeys = new Set(roleRows.map((r) => r.key));
  const roles = tokens.filter((t) => roleKeys.has(t));
  const wantsEveryone = tokens.includes('everyone') && perms.mention_everyone;
  const wantsHere = tokens.includes('here') && perms.mention_everyone;
  const handles = tokens.filter((t) => !roleKeys.has(t) && t !== 'everyone' && t !== 'here');
  const ids = new Set<string>();
  if (handles.length) {
    const owners = await db.select({ id: communityHandles.ownerId }).from(communityHandles).where(and(inArray(communityHandles.key, handles), isNull(communityHandles.releasedAt)));
    const members = owners.length
      ? await db.select({ id: communityMembers.actorId }).from(communityMembers).where(and(eq(communityMembers.hengeId, acc.henge.id), inArray(communityMembers.actorId, owners.map((o) => o.id))))
      : [];
    for (const m of members) ids.add(m.id);
  }
  if (wantsHere && !wantsEveryone) {
    // @here reaches whoever is online right now, so it is resolved to people at send time.
    const online = await db
      .select({ id: communityPresence.actorId, status: communityPresence.status, updatedAt: communityPresence.updatedAt })
      .from(communityPresence)
      .where(eq(communityPresence.hengeId, acc.henge.id));
    for (const p of online) if (presenceOf(p, '', now) !== 'offline') ids.add(p.id);
  }
  ids.delete(acc.actor.id);
  return { actorIds: [...ids], roles, everyone: wantsEveryone };
}

/* ---------------------------------------------------------------------------------------------- */
/* Posting                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

async function loadMessage(db: Exec, hengeId: string, messageId: string) {
  if (!ULID_RE.test(messageId)) throw notFound('message');
  const [m] = await db.select().from(communityMessages).where(and(eq(communityMessages.id, messageId), eq(communityMessages.hengeId, hengeId))).limit(1);
  if (!m) throw notFound('message');
  return m;
}

async function requireNotTimedOut(acc: Access, now: Date) {
  const t = await activeTimeout(await getDb(), acc.henge.id, actorIds(acc.actor), now);
  if (t) throw forbidden('timed_out', 'You are timed out in this Henge.', { until: t.until.toISOString() });
}

const isNewAccount = (acc: Access, now: Date) => now.getTime() - acc.actor.accountCreatedAt.getTime() < NEW_ACCOUNT_MS;

/** Whether the Moderation Glyph's link filter holds this message for review. */
function linkFilterHolds(acc: Access, body: string, now: Date): boolean {
  const g = moderationGlyph(acc.file);
  if (!g || g.linkFilter === 'off' || !containsLink(body)) return false;
  return g.linkFilter === 'all' || isNewAccount(acc, now);
}

async function enforceRateLimits(acc: Access, channel: CommunityChannel, perms: FullPerms, now: Date) {
  const limits = rateLimits(acc.file);
  const a = acc.actor;
  if (channel.slowModeS > 0 && !perms.manage_messages) {
    const t = await takeSlowMode(`slow:${channel.id}:${a.id}`, channel.slowModeS, now);
    if (!t.ok) throw rateLimited(t.retryAfterS, `Slow mode is on. You can post again in ${t.retryAfterS} s.`, 'slow_mode');
  }
  const t =
    a.type === 'agent'
      ? await takePerMinute(`msg:agent:${a.id}:${channel.id}`, limits.agent_messages_per_minute, now)
      : isNewAccount(acc, now)
        ? await takePerMinute(`msg:new:${a.id}:${acc.henge.id}`, limits.new_account_messages_per_minute, now)
        : await takePerMinute(`msg:human:${a.id}:${acc.henge.id}`, limits.human_messages_per_minute, now);
  if (!t.ok) throw rateLimited(t.retryAfterS, `You are sending messages quickly. Try again in ${t.retryAfterS} s.`);
}

/** Held messages go to their author and to members who can manage messages in the channel. */
async function heldAudience(acc: Access, channel: CommunityChannel): Promise<string[]> {
  return [acc.actor.id, ...(await membersWithPerm(acc.henge.id, channel, 'manage_messages', acc.actor.id))];
}

export type PostInput = { body: unknown; reply_to?: string | null; thread_root?: string | null };

export async function postMessage(acc: Access, channelId: string, input: PostInput, now = new Date()): Promise<MessageDto> {
  const { channel, perms } = await channelAccess(acc, channelId);
  const db = await getDb();
  const body = cleanBody(input.body);
  let root: CommunityMessage | null = null;
  if (input.thread_root) {
    root = await loadMessage(db, acc.henge.id, input.thread_root);
    if (root.channelId !== channel.id || root.threadRoot !== null || root.deletedAt || root.held) throw invalid('thread_root_invalid', 'That message cannot hold a thread.');
  }
  const decision = canPost({ actorType: acc.actor.type, perms, channelType: channel.type, agentsPolicy: channel.agentsPolicy, thread: root ? { starting: root.threadReplyCount === 0 } : null });
  if (!decision.ok) {
    if (acc.actor.type === 'agent') {
      // Spec 8.3: an agent posting where its role may not is refused and logged.
      await audit(db, { hengeId: acc.henge.id, actor: { type: 'agent', id: acc.actor.id }, action: 'agent.post_refused', targetType: 'channel', targetId: channel.id, reason: decision.code, payload: { channel: channel.name, thread_root: root?.id ?? null } }, now);
    }
    throw forbidden(decision.code, decision.message);
  }
  await requireNotTimedOut(acc, now);
  if (input.reply_to) {
    const target = await loadMessage(db, acc.henge.id, input.reply_to);
    if (target.channelId !== channel.id) throw invalid('reply_to_invalid', 'Replies stay in the same channel.');
  }
  await enforceRateLimits(acc, channel, perms, now);
  const mentions = await resolveMentions(db, acc, body, perms, now);
  const held = linkFilterHolds(acc, body, now);
  const id = ulid(now.getTime());

  const row = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(communityMessages)
      .values({
        id,
        hengeId: acc.henge.id,
        channelId: channel.id,
        authorType: acc.actor.type,
        authorId: acc.actor.id,
        body,
        replyTo: input.reply_to ?? null,
        threadRoot: root?.id ?? null,
        mentionActorIds: mentions.actorIds,
        mentionRoles: mentions.roles,
        mentionEveryone: mentions.everyone,
        held,
        createdAt: now,
      })
      .returning();
    if (root && !held) {
      await tx
        .update(communityMessages)
        .set({ threadReplyCount: sql`${communityMessages.threadReplyCount} + 1`, threadLastReplyAt: now })
        .where(eq(communityMessages.id, root.id));
    }
    // Posting marks the channel (or thread) read up to your own message.
    await tx
      .insert(communityReadState)
      .values({ actorId: acc.actor.id, channelId: channel.id, threadRoot: root?.id ?? '', lastReadMessageId: id, updatedAt: now })
      .onConflictDoUpdate({
        target: [communityReadState.actorId, communityReadState.channelId, communityReadState.threadRoot],
        set: { lastReadMessageId: sql`greatest(${communityReadState.lastReadMessageId}, excluded.last_read_message_id)`, updatedAt: now },
      });
    return m!;
  });
  const [dto] = await messageDtos(db, [row], null);
  if (held) {
    await audit(db, { hengeId: acc.henge.id, actor: GLYPH_ACTOR, action: 'message.held', targetType: 'message', targetId: id, reason: 'Rune: link_filter', payload: { channel: channel.name, author_id: acc.actor.id } }, now);
    await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'message.held', payload: { message: dto }, audience: await heldAudience(acc, channel) }, now);
  } else {
    await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'message.created', payload: { message: dto } }, now);
    if (root) await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'thread.updated', payload: { message_id: root.id, reply_count: root.threadReplyCount + 1, last_reply_at: now.toISOString() } }, now);
  }
  void maybePurge(acc.henge.id, acc.file.data_policy.retention_days, now).catch(() => undefined);
  return { ...dto!, reactions: [] };
}

/* ---------------------------------------------------------------------------------------------- */
/* Reading                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export type Page = { items: MessageDto[]; next_before: string | null };

function visibility(acc: Access, perms: FullPerms): SQL | undefined {
  // Held messages: only their author and members who manage messages. Deleted ones: only as thread anchors.
  const notHeld = perms.manage_messages ? undefined : or(eq(communityMessages.held, false), eq(communityMessages.authorId, acc.actor.id));
  const notDeleted = or(isNull(communityMessages.deletedAt), gt(communityMessages.threadReplyCount, 0));
  return and(notDeleted, notHeld);
}

export async function listMessages(acc: Access, channelId: string, q: { before?: string; after?: string; limit?: number }): Promise<Page> {
  const { channel, perms } = await channelAccess(acc, channelId);
  const db = await getDb();
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), 100);
  for (const c of [q.before, q.after]) if (c !== undefined && !ULID_RE.test(c)) throw invalid('cursor_invalid', 'Cursors are message ids.');
  const where = and(
    eq(communityMessages.channelId, channel.id),
    isNull(communityMessages.threadRoot),
    visibility(acc, perms),
    q.before ? lt(communityMessages.id, q.before) : undefined,
    q.after ? gt(communityMessages.id, q.after) : undefined,
  );
  const rows = await db
    .select()
    .from(communityMessages)
    .where(where)
    .orderBy(q.after ? asc(communityMessages.id) : desc(communityMessages.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const chronological = q.after ? page : page.reverse();
  return { items: await messageDtos(db, chronological, acc.actor.id), next_before: !q.after && more ? chronological[0]!.id : null };
}

export async function getThread(acc: Access, messageId: string, q: { after?: string; limit?: number }) {
  const db = await getDb();
  const root = await loadMessage(db, acc.henge.id, messageId);
  const { perms } = await channelAccess(acc, root.channelId);
  if (root.threadRoot !== null) throw invalid('not_a_thread_root', 'Open the thread from its first message.');
  if (root.held && !perms.manage_messages && root.authorId !== acc.actor.id) throw notFound('message');
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 100), 1), 200);
  if (q.after !== undefined && !ULID_RE.test(q.after)) throw invalid('cursor_invalid', 'Cursors are message ids.');
  const replies = await db
    .select()
    .from(communityMessages)
    .where(and(eq(communityMessages.threadRoot, root.id), visibility(acc, perms), isNull(communityMessages.deletedAt), q.after ? gt(communityMessages.id, q.after) : undefined))
    .orderBy(asc(communityMessages.id))
    .limit(limit + 1);
  const more = replies.length > limit;
  const [rootDto, ...items] = await messageDtos(db, [root, ...replies.slice(0, limit)], acc.actor.id);
  return { root: rootDto!, items, next_after: more ? items[items.length - 1]!.id : null };
}

/* ---------------------------------------------------------------------------------------------- */
/* Edit, delete, release                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const ownsMessage = (acc: Access, m: CommunityMessage) => m.authorId === acc.actor.id;

export async function editMessage(acc: Access, messageId: string, rawBody: unknown, now = new Date()): Promise<MessageDto> {
  const db = await getDb();
  const m = await loadMessage(db, acc.henge.id, messageId);
  const { channel, perms } = await channelAccess(acc, m.channelId);
  if (!ownsMessage(acc, m)) throw forbidden('not_your_message', 'Only the author can edit a message.');
  if (m.deletedAt) throw notFound('message');
  await requireNotTimedOut(acc, now);
  const body = cleanBody(rawBody);
  const mentions = await resolveMentions(db, acc, body, perms, now);
  const held = m.held || linkFilterHolds(acc, body, now);
  const [row] = await db
    .update(communityMessages)
    .set({ body, editedAt: now, mentionActorIds: mentions.actorIds, mentionRoles: mentions.roles, mentionEveryone: mentions.everyone, held })
    .where(eq(communityMessages.id, m.id))
    .returning();
  const [dto] = await messageDtos(db, [row!], null);
  if (held && !m.held) {
    await audit(db, { hengeId: acc.henge.id, actor: GLYPH_ACTOR, action: 'message.held', targetType: 'message', targetId: m.id, reason: 'Rune: link_filter', payload: { channel: channel.name, author_id: acc.actor.id } }, now);
    await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'message.deleted', payload: { message_id: m.id, thread_root: m.threadRoot } }, now);
    await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'message.held', payload: { message: dto }, audience: await heldAudience(acc, channel) }, now);
  } else {
    await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'message.updated', payload: { message: dto }, audience: held ? await heldAudience(acc, channel) : null }, now);
  }
  return dto!;
}

/**
 * Soft delete (kept 30 days as evidence, then purged). Authors delete their own; an agent's owner can
 * delete the agent's messages; anyone else needs `manage_messages` and the action is audited.
 */
export async function deleteMessage(acc: Access, messageId: string, reason: string | null, now = new Date()) {
  const db = await getDb();
  const m = await loadMessage(db, acc.henge.id, messageId);
  const { channel, perms } = await channelAccess(acc, m.channelId);
  if (m.deletedAt) return { deleted: true };
  let moderated = false;
  if (!ownsMessage(acc, m)) {
    const agentOwner =
      m.authorType === 'agent' && acc.actor.type === 'human'
        ? (await db.select().from(communityMembers).where(and(eq(communityMembers.hengeId, acc.henge.id), eq(communityMembers.actorId, m.authorId!))).limit(1))[0]?.ownerAccountId === acc.actor.id
        : false;
    if (!agentOwner) {
      if (!perms.manage_messages) throw forbidden('cannot_manage_messages', "Your role cannot delete other members' messages here.");
      moderated = true;
    }
  }
  await softDelete(db, m, { type: acc.actor.type, id: acc.actor.id }, reason, now);
  if (moderated) {
    await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'message.deleted', targetType: m.authorType, targetId: m.authorId, reason, payload: { message_id: m.id, channel: channel.name, kept_days: 30 } }, now);
  }
  return { deleted: true };
}

export async function softDelete(db: Exec, m: CommunityMessage, by: { type: string; id: string }, reason: string | null, now: Date) {
  await db
    .update(communityMessages)
    .set({ deletedAt: now, deletedByType: by.type, deletedById: by.id, deleteReason: reason })
    .where(and(eq(communityMessages.id, m.id), isNull(communityMessages.deletedAt)));
  if (m.threadRoot && !m.held) {
    await db
      .update(communityMessages)
      .set({ threadReplyCount: sql`greatest(0, ${communityMessages.threadReplyCount} - 1)` })
      .where(eq(communityMessages.id, m.threadRoot));
  }
  await db.delete(communityPins).where(eq(communityPins.messageId, m.id));
  await emit(db, { hengeId: m.hengeId, channelId: m.channelId, kind: 'message.deleted', payload: { message_id: m.id, thread_root: m.threadRoot } }, now);
}

/** A moderator releases a message the link filter held. */
export async function releaseHeld(acc: Access, messageId: string, now = new Date()) {
  const db = await getDb();
  const m = await loadMessage(db, acc.henge.id, messageId);
  const { channel, perms } = await channelAccess(acc, m.channelId);
  if (!perms.manage_messages) throw forbidden('cannot_manage_messages', 'Your role cannot release held messages.');
  if (!m.held || m.deletedAt) throw new CommunityError(409, 'not_held', 'That message is not held.');
  const [row] = await db.update(communityMessages).set({ held: false }).where(eq(communityMessages.id, m.id)).returning();
  if (m.threadRoot) {
    await db.update(communityMessages).set({ threadReplyCount: sql`${communityMessages.threadReplyCount} + 1`, threadLastReplyAt: m.createdAt }).where(eq(communityMessages.id, m.threadRoot));
  }
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'message.released', targetType: 'message', targetId: m.id, payload: { channel: channel.name } }, now);
  const [dto] = await messageDtos(db, [row!], null);
  await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'message.created', payload: { message: dto } }, now);
  return dto!;
}

/* ---------------------------------------------------------------------------------------------- */
/* Reactions                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

const EMOJI_RE = new RegExp('^\\p{RGI_Emoji}$', 'v');
export const MAX_DISTINCT_REACTIONS = 20;
export const isUnicodeEmoji = (s: string) => s.length <= 64 && EMOJI_RE.test(s);

export async function addReaction(acc: Access, messageId: string, emoji: string, now = new Date()) {
  if (!isUnicodeEmoji(emoji)) throw invalid('emoji_invalid', 'Reactions are a single Unicode emoji.');
  const db = await getDb();
  const m = await loadMessage(db, acc.henge.id, messageId);
  const { channel, perms } = await channelAccess(acc, m.channelId);
  if (!perms.add_reactions) throw forbidden('cannot_react', 'Your role cannot add reactions here.');
  if (m.deletedAt || m.held) throw notFound('message');
  await requireNotTimedOut(acc, now);
  const [mine] = await db.select().from(communityReactions).where(and(eq(communityReactions.messageId, m.id), eq(communityReactions.actorId, acc.actor.id), eq(communityReactions.emoji, emoji))).limit(1);
  if (mine) return reactionCount(m.id, emoji);
  const distinct = await db.selectDistinct({ emoji: communityReactions.emoji }).from(communityReactions).where(eq(communityReactions.messageId, m.id));
  if (distinct.length >= MAX_DISTINCT_REACTIONS && !distinct.some((d) => d.emoji === emoji)) throw new CommunityError(409, 'too_many_reactions', 'This message has as many different reactions as it can hold.');
  const t = await takePerMinute(`react:${acc.actor.id}:${acc.henge.id}`, rateLimits(acc.file).reactions_per_minute, now);
  if (!t.ok) throw rateLimited(t.retryAfterS, `You are reacting quickly. Try again in ${t.retryAfterS} s.`);
  // One reaction per emoji per actor: the primary key makes a repeat a no-op.
  await db.insert(communityReactions).values({ messageId: m.id, actorId: acc.actor.id, actorType: acc.actor.type, emoji, createdAt: now }).onConflictDoNothing();
  const r = await reactionCount(m.id, emoji);
  await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'reaction.added', payload: { message_id: m.id, emoji, actor_id: acc.actor.id, count: r.count } }, now);
  return r;
}

export async function removeReaction(acc: Access, messageId: string, emoji: string, now = new Date()) {
  const db = await getDb();
  const m = await loadMessage(db, acc.henge.id, messageId);
  const { channel } = await channelAccess(acc, m.channelId);
  const gone = await db.delete(communityReactions).where(and(eq(communityReactions.messageId, m.id), eq(communityReactions.actorId, acc.actor.id), eq(communityReactions.emoji, emoji))).returning();
  const r = await reactionCount(m.id, emoji);
  if (gone.length) await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'reaction.removed', payload: { message_id: m.id, emoji, actor_id: acc.actor.id, count: r.count } }, now);
  return r;
}

async function reactionCount(messageId: string, emoji: string) {
  const db = await getDb();
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(communityReactions).where(and(eq(communityReactions.messageId, messageId), eq(communityReactions.emoji, emoji)))) as [{ n: number }];
  return { message_id: messageId, emoji, count: n };
}

/* ---------------------------------------------------------------------------------------------- */
/* Pins                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

export const MAX_PINS_PER_CHANNEL = 50;

export async function pinMessage(acc: Access, messageId: string, pinned: boolean, now = new Date()) {
  const db = await getDb();
  const m = await loadMessage(db, acc.henge.id, messageId);
  const { channel, perms } = await channelAccess(acc, m.channelId);
  if (!perms.manage_messages && !can(acc, 'pin')) throw forbidden('cannot_pin', 'Your role cannot pin messages here.');
  if (m.deletedAt || m.held) throw notFound('message');
  if (pinned) {
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(communityPins).where(eq(communityPins.channelId, channel.id))) as [{ n: number }];
    if (n >= MAX_PINS_PER_CHANNEL) throw new CommunityError(409, 'too_many_pins', `A channel holds at most ${MAX_PINS_PER_CHANNEL} pins.`);
    const ins = await db.insert(communityPins).values({ channelId: channel.id, messageId: m.id, pinnedByType: acc.actor.type, pinnedById: acc.actor.id, pinnedAt: now }).onConflictDoNothing().returning();
    if (!ins.length) return { pinned: true };
  } else {
    const del = await db.delete(communityPins).where(and(eq(communityPins.channelId, channel.id), eq(communityPins.messageId, m.id))).returning();
    if (!del.length) return { pinned: false };
  }
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: pinned ? 'message.pinned' : 'message.unpinned', targetType: 'message', targetId: m.id, payload: { channel: channel.name, excerpt: m.body.slice(0, 140) } }, now);
  await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: pinned ? 'pin.added' : 'pin.removed', payload: { message_id: m.id } }, now);
  return { pinned };
}

export async function listPins(acc: Access, channelId: string) {
  const { channel } = await channelAccess(acc, channelId);
  const db = await getDb();
  const pins = await db.select().from(communityPins).where(eq(communityPins.channelId, channel.id)).orderBy(desc(communityPins.pinnedAt));
  if (!pins.length) return { items: [] };
  const rows = await db.select().from(communityMessages).where(inArray(communityMessages.id, pins.map((p) => p.messageId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = pins.map((p) => byId.get(p.messageId)).filter((m): m is CommunityMessage => !!m && !m.deletedAt);
  const dtos = await messageDtos(db, ordered, acc.actor.id);
  const by = await actorCards(db, pins.map((p) => ({ type: p.pinnedByType, id: p.pinnedById })));
  return {
    items: dtos.map((d) => {
      const p = pins.find((x) => x.messageId === d.id)!;
      return { message: d, pinned_by: by.get(p.pinnedById) ?? deletedCard(p.pinnedById), pinned_at: p.pinnedAt.toISOString() };
    }),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Read state and unread counts                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export async function markRead(acc: Access, channelId: string, input: { message_id: string; thread_root?: string | null }, now = new Date()) {
  const { channel } = await channelAccess(acc, channelId);
  if (!ULID_RE.test(input.message_id)) throw invalid('cursor_invalid', 'Read markers are message ids.');
  const db = await getDb();
  if (input.thread_root) {
    const root = await loadMessage(db, acc.henge.id, input.thread_root);
    if (root.channelId !== channel.id) throw notFound('message');
  }
  const thread = input.thread_root ?? '';
  const [row] = await db
    .insert(communityReadState)
    .values({ actorId: acc.actor.id, channelId: channel.id, threadRoot: thread, lastReadMessageId: input.message_id, updatedAt: now })
    .onConflictDoUpdate({
      target: [communityReadState.actorId, communityReadState.channelId, communityReadState.threadRoot],
      set: { lastReadMessageId: sql`greatest(${communityReadState.lastReadMessageId}, excluded.last_read_message_id)`, updatedAt: now },
    })
    .returning();
  // Read state syncs across the actor's devices.
  await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'read.updated', payload: { channel_id: channel.id, thread_root: input.thread_root ?? null, last_read_message_id: row!.lastReadMessageId }, audience: [acc.actor.id] }, now);
  return { channel_id: channel.id, thread_root: input.thread_root ?? null, last_read_message_id: row!.lastReadMessageId };
}

export type UnreadDto = {
  channels: { channel_id: string; unread: number; mentions: number; last_message_id: string | null; last_read_message_id: string | null }[];
  threads: { channel_id: string; thread_root: string; unread: number }[];
  total_unread: number;
  total_mentions: number;
};

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

/** Unread and mention counts per visible channel, plus threads the actor follows (has a marker in). */
export async function unreadCounts(acc: Access): Promise<UnreadDto> {
  const { channels } = await listChannels(acc);
  const ids = channels.map((c) => c.id);
  if (!ids.length) return { channels: [], threads: [], total_unread: 0, total_mentions: 0 };
  const db = await getDb();
  const me = acc.actor.id;
  const joinFloor = ulidFloor(acc.member.joinedAt.getTime());
  const roles = acc.roles.length ? acc.roles : ['none'];
  const counts = rowsOf<{ channel_id: string; unread: number; mentions: number }>(
    await db.execute(sql`
      select m.channel_id, count(*)::int as unread,
        count(*) filter (where ${me}::uuid = any(m.mention_actor_ids) or m.mention_roles && array[${sqlList(roles)}]::text[] or m.mention_everyone)::int as mentions
      from community_messages m
      left join community_read_state r on r.actor_id = ${me}::uuid and r.channel_id = m.channel_id and r.thread_root = ''
      where m.channel_id in (${sqlList(ids)}) and m.thread_root is null and m.deleted_at is null and m.held = false
        and (m.author_id is null or m.author_id <> ${me}::uuid)
        and m.id > coalesce(r.last_read_message_id, ${joinFloor})
      group by m.channel_id`),
  );
  const lasts = rowsOf<{ channel_id: string; last_id: string }>(
    await db.execute(sql`select channel_id, max(id) as last_id from community_messages where channel_id in (${sqlList(ids)}) and thread_root is null and deleted_at is null and held = false group by channel_id`),
  );
  const markers = await db.select().from(communityReadState).where(and(eq(communityReadState.actorId, me), inArray(communityReadState.channelId, ids)));
  const threads = rowsOf<{ channel_id: string; thread_root: string; unread: number }>(
    await db.execute(sql`
      select r.channel_id, r.thread_root, count(m.id)::int as unread
      from community_read_state r
      join community_messages m on m.thread_root = r.thread_root and m.id > r.last_read_message_id and m.deleted_at is null and m.held = false and (m.author_id is null or m.author_id <> ${me}::uuid)
      where r.actor_id = ${me}::uuid and r.thread_root <> '' and r.channel_id in (${sqlList(ids)})
      group by r.channel_id, r.thread_root`),
  );
  const cmap = new Map(counts.map((c) => [c.channel_id, c]));
  const lmap = new Map(lasts.map((l) => [l.channel_id, l.last_id]));
  const mmap = new Map(markers.filter((m) => m.threadRoot === '').map((m) => [m.channelId, m.lastReadMessageId]));
  const list = ids.map((id) => ({ channel_id: id, unread: cmap.get(id)?.unread ?? 0, mentions: cmap.get(id)?.mentions ?? 0, last_message_id: lmap.get(id) ?? null, last_read_message_id: mmap.get(id) ?? null }));
  return {
    channels: list,
    threads: threads.filter((t) => t.unread > 0),
    total_unread: list.reduce((s, c) => s + c.unread, 0),
    total_mentions: list.reduce((s, c) => s + c.mentions, 0),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Typing and presence                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/** Typing indicators last this long on the client unless renewed. */
export const TYPING_TTL_MS = 6000;
/** One stored typing event per actor and channel per this interval. */
export const TYPING_THROTTLE_MS = 2500;
const lastTyping = new Map<string, number>();

export async function typing(acc: Access, channelId: string, input: { thread_root?: string | null }, now = new Date()) {
  const { channel, perms } = await channelAccess(acc, channelId);
  if (!perms.send && !perms.start_threads && !perms.post_via_api) throw forbidden('cannot_send', 'Your role cannot post in this channel.');
  const key = `${acc.actor.id}:${channel.id}:${input.thread_root ?? ''}`;
  const prev = lastTyping.get(key) ?? 0;
  if (now.getTime() - prev < TYPING_THROTTLE_MS) return { ok: true, expires_in_ms: TYPING_TTL_MS };
  lastTyping.set(key, now.getTime());
  if (lastTyping.size > 10_000) lastTyping.clear();
  const db = await getDb();
  const cards = await actorCards(db, [{ type: acc.actor.type, id: acc.actor.id }]);
  await emit(db, { hengeId: acc.henge.id, channelId: channel.id, kind: 'typing', payload: { actor: cards.get(acc.actor.id), thread_root: input.thread_root ?? null, expires_in_ms: TYPING_TTL_MS } }, now);
  return { ok: true, expires_in_ms: TYPING_TTL_MS };
}

export const HUMAN_STATUSES = ['online', 'idle', 'dnd', 'offline'] as const;
export const AGENT_STATUSES = ['running', 'paused', 'offline'] as const;

/** Presence heartbeat. Humans: online, idle, dnd, offline. Agents (from their node): running, paused, offline. */
export async function heartbeat(acc: Access, status: string, now = new Date()) {
  const allowed: readonly string[] = acc.actor.type === 'agent' ? AGENT_STATUSES : HUMAN_STATUSES;
  if (!allowed.includes(status)) throw invalid('status_invalid', `Status is one of ${allowed.join(', ')}.`);
  const db = await getDb();
  const [prev] = await db.select().from(communityPresence).where(and(eq(communityPresence.hengeId, acc.henge.id), eq(communityPresence.actorId, acc.actor.id))).limit(1);
  await db
    .insert(communityPresence)
    .values({ hengeId: acc.henge.id, actorId: acc.actor.id, actorType: acc.actor.type, status, updatedAt: now })
    .onConflictDoUpdate({ target: [communityPresence.hengeId, communityPresence.actorId], set: { status, updatedAt: now } });
  const before = presenceOf(prev, acc.actor.type, now);
  if (before !== status) await emit(db, { hengeId: acc.henge.id, kind: 'presence', payload: { actor_id: acc.actor.id, actor_type: acc.actor.type, status } }, now);
  return { status, ttl_ms: PRESENCE_TTL_MS };
}
