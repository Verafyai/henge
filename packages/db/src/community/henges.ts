/**
 * Henges, memberships, roles, channels and agent tokens (spin-out spec 8.1, 8.2).
 */
import { hengeFileDigest, parseHenge, type HengeV1 } from '@swarm-explorer/schema';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../client';
import {
  communityAgentTokens,
  communityAgents,
  communityCategories,
  communityChannelOverrides,
  communityChannels,
  communityMembers,
  communityPresence,
  communityRoles,
  henges,
  type CommunityChannel,
  type CommunityMember,
  type Henge,
  type PermSet,
} from '../community-schema';
import { accounts } from '../schema';
import {
  access,
  activeBan,
  actorCards,
  audit,
  can,
  channelOverrides,
  CommunityError,
  emit,
  forbidden,
  isUuid,
  loadHenge,
  notFound,
  permsIn,
  requireCap,
  roleMaps,
  type Access,
  type Actor,
  type ActorCard,
  type Exec,
} from './context';
import { PRESENCE_TTL_MS } from './config';
import { BUILTIN_ROLES, CHANNEL_PERMS, channelSeed, effectivePerms, rank, rolesFromHenge, type FullPerms } from './perms';
import { hashAgentToken, newAgentToken, requireProfile } from './profiles';

const invalid = (code: string, message: string, details?: Record<string, unknown>) => new CommunityError(400, code, message, details);

/* ---------------------------------------------------------------------------------------------- */
/* Create and join                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

export type HengeSummary = {
  id: string;
  ref: string;
  name: string;
  version: string;
  source_url: string | null;
  pinned_digest: string;
  admission_mode: string;
  owner_account_id: string;
  created_at: string;
};

export function hengeSummary(h: Henge): HengeSummary {
  const f = h.hengeFile as HengeV1;
  return {
    id: h.id,
    ref: h.ref,
    name: h.name,
    version: h.version,
    source_url: h.sourceUrl,
    pinned_digest: h.pinnedDigest,
    admission_mode: f.admission.mode,
    owner_account_id: h.ownerAccountId,
    created_at: h.createdAt.toISOString(),
  };
}

/** Roles a `.henge` file's `governance.holders` gives to an account handle. */
function holderRoles(f: HengeV1, accountHandle: string): string[] {
  const out: string[] = [];
  for (const [role, list] of Object.entries(f.governance.holders)) {
    if (Array.isArray(list) && list.some((h) => h.toLowerCase() === accountHandle.toLowerCase())) out.push(role);
  }
  return out;
}

async function seedCommunity(tx: Exec, henge: Henge, f: HengeV1) {
  const roles = rolesFromHenge(f);
  await tx.insert(communityRoles).values(roles.map((r) => ({ hengeId: henge.id, key: r.key, name: r.name, builtin: r.builtin, position: r.position, perms: r.perms, capabilities: r.capabilities })));
  const roleKeys = roles.map((r) => r.key);
  let catPos = 0;
  for (const cat of f.community?.categories ?? []) {
    const [c] = await tx.insert(communityCategories).values({ hengeId: henge.id, key: cat.id, name: cat.name ?? cat.id, position: catPos++ }).returning();
    let chPos = 0;
    for (const ch of cat.channels) {
      const seed = channelSeed(ch, roleKeys);
      const [row] = await tx
        .insert(communityChannels)
        .values({
          hengeId: henge.id,
          categoryId: c!.id,
          key: ch.id,
          name: ch.name ?? ch.id,
          type: ch.type,
          slowModeS: ch.slow_mode_s ?? 0,
          position: chPos++,
          public: seed.public,
          agentsPolicy: ch.agents ?? null,
          glyphPosts: ch.glyph_posts ?? [],
        })
        .returning();
      const entries = Object.entries(seed.overrides);
      if (entries.length) await tx.insert(communityChannelOverrides).values(entries.map(([roleKey, perms]) => ({ channelId: row!.id, roleKey, perms })));
    }
  }
}

export type JoinResult = { henge: Henge; member: CommunityMember; created: boolean };

/**
 * Creates a Henge from a `.henge` file, or joins it when a Henge with the same `id` exists and the
 * file's digest matches the pinned one. The creator must be listed in `governance.holders.owner`.
 */
export async function createOrJoinHenge(actor: Actor, input: { source: string; sourceUrl?: string | null }, now = new Date()): Promise<JoinResult> {
  if (actor.type !== 'human') throw forbidden('humans_only', 'Only people can create or join a Henge.');
  await requireProfile(actor.id);
  if (input.source.length > 256 * 1024) throw invalid('henge_too_large', 'The .henge file is larger than 256 KB.');
  const parsed = parseHenge(input.source);
  if (!parsed.ok) throw new CommunityError(422, 'henge_invalid', 'The .henge file did not validate.', { issues: parsed.issues.slice(0, 20) });
  const f = parsed.henge;
  if (f.community?.enabled === false) throw new CommunityError(422, 'community_disabled', 'This Henge has its community layer turned off.');
  const digest = await hengeFileDigest(input.source);
  const db = await getDb();
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, actor.id)).limit(1);

  const [existing] = await db.select().from(henges).where(eq(henges.ref, f.id)).limit(1);
  if (existing) {
    if (existing.pinnedDigest !== digest) {
      throw new CommunityError(409, 'henge_digest_mismatch', 'This file does not match the version this Henge is pinned to.', { henge_id: existing.id, pinned_digest: existing.pinnedDigest, digest });
    }
    const member = await joinHenge(actor, existing.id, {}, now);
    return { henge: existing, member, created: false };
  }
  if (!holderRoles(f, acct!.handle).includes('owner')) {
    throw forbidden('not_an_owner', 'Only an account listed in governance.holders.owner can start this Henge.');
  }
  return db.transaction(async (tx) => {
    const [h] = await tx
      .insert(henges)
      .values({ ref: f.id, name: f.name, version: f.version, sourceUrl: input.sourceUrl ?? null, pinnedDigest: digest, hengeFile: f, ownerAccountId: actor.id, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!h) throw new CommunityError(409, 'henge_exists', 'This Henge was just created. Join it instead.');
    await seedCommunity(tx, h, f);
    const roles = [...new Set(['owner', ...holderRoles(f, acct!.handle)])];
    const [member] = await tx.insert(communityMembers).values({ hengeId: h.id, actorId: actor.id, actorType: 'human', ownerAccountId: actor.id, roles, joinedAt: now }).returning();
    await audit(tx, { hengeId: h.id, actor: { type: 'human', id: actor.id }, action: 'henge.created', targetType: 'henge', targetId: h.id, payload: { ref: f.id, digest } }, now);
    return { henge: h, member: member!, created: true };
  });
}

export async function joinHenge(actor: Actor, hengeId: string, opts: { asObserver?: boolean }, now = new Date()): Promise<CommunityMember> {
  if (actor.type !== 'human') throw forbidden('humans_only', 'Agents are added by their owner.');
  await requireProfile(actor.id);
  const db = await getDb();
  const henge = await loadHenge(db, hengeId);
  const f = henge.hengeFile as HengeV1;
  const ban = await activeBan(db, henge.id, [actor.id]);
  if (ban) throw forbidden('banned', 'You are banned from this Henge.', { appeal_until: ban.appealUntil?.toISOString() ?? null });
  const [already] = await db.select().from(communityMembers).where(and(eq(communityMembers.hengeId, henge.id), eq(communityMembers.actorId, actor.id))).limit(1);
  if (already) return already;
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, actor.id)).limit(1);
  const held = holderRoles(f, acct!.handle);
  if (f.admission.mode !== 'open' && held.length === 0) {
    throw forbidden('admission_required', `This Henge admits members by ${f.admission.mode}. Ask a maintainer to let you in.`, { mode: f.admission.mode });
  }
  const max = f.admission.capacity?.max_members;
  if (typeof max === 'number') {
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(communityMembers).where(and(eq(communityMembers.hengeId, henge.id), eq(communityMembers.actorType, 'human')))) as [{ n: number }];
    if (n >= max) throw forbidden('henge_full', 'This Henge is full.');
  }
  const base = opts.asObserver ? 'observer' : (f.community?.defaults?.new_member_role ?? 'member');
  const roles = [...new Set([...held.filter((r) => r !== 'owner'), base])];
  const [member] = await db.insert(communityMembers).values({ hengeId: henge.id, actorId: actor.id, actorType: 'human', ownerAccountId: actor.id, roles, joinedAt: now }).onConflictDoNothing().returning();
  const row = member ?? already!;
  await emit(db, { hengeId: henge.id, kind: 'member.joined', payload: { actor_id: actor.id, actor_type: 'human', roles: row.roles } }, now);
  return row;
}

/** Leaving also removes the member's agents from this Henge and revokes their tokens. The owner cannot leave. */
export async function leaveHenge(actor: Actor, hengeId: string, now = new Date()) {
  const acc = await access(actor, hengeId);
  if (acc.roles.includes('owner')) throw new CommunityError(409, 'owner_cannot_leave', 'The owner cannot leave their own Henge.');
  await removeMember(acc.henge.id, actor.type === 'human' ? actor.id : actor.accountId, actor.type === 'agent' ? actor.id : null, now);
}

/** Removes a human and all their agents (or only one agent) from a Henge. */
export async function removeMember(hengeId: string, accountId: string, onlyAgentId: string | null, now: Date, db?: Exec) {
  const d = db ?? (await getDb());
  const rows = onlyAgentId
    ? await d.delete(communityMembers).where(and(eq(communityMembers.hengeId, hengeId), eq(communityMembers.actorId, onlyAgentId))).returning()
    : await d.delete(communityMembers).where(and(eq(communityMembers.hengeId, hengeId), eq(communityMembers.ownerAccountId, accountId))).returning();
  const agentIds = rows.filter((r) => r.actorType === 'agent').map((r) => r.actorId);
  if (agentIds.length) {
    await d
      .update(communityAgentTokens)
      .set({ revokedAt: now, revokedByType: 'system', revokedById: 'membership_ended' })
      .where(and(eq(communityAgentTokens.hengeId, hengeId), inArray(communityAgentTokens.agentId, agentIds), isNull(communityAgentTokens.revokedAt)));
  }
  for (const r of rows) await emit(d, { hengeId, kind: 'member.left', payload: { actor_id: r.actorId, actor_type: r.actorType } }, now);
  return rows;
}

export async function myHenges(actor: Actor) {
  const db = await getDb();
  const rows = await db
    .select({ henge: henges, member: communityMembers })
    .from(communityMembers)
    .innerJoin(henges, eq(henges.id, communityMembers.hengeId))
    .where(eq(communityMembers.actorId, actor.id))
    .orderBy(asc(communityMembers.joinedAt));
  return rows;
}

/* ---------------------------------------------------------------------------------------------- */
/* Members and presence                                                                            */
/* ---------------------------------------------------------------------------------------------- */

export type MemberDto = { actor: ActorCard; roles: string[]; nickname: string | null; joined_at: string; presence: string };

export function presenceOf(row: { status: string; updatedAt: Date } | undefined, type: string, now: Date): string {
  if (!row || now.getTime() - row.updatedAt.getTime() > PRESENCE_TTL_MS) return 'offline';
  return row.status === 'offline' ? 'offline' : row.status;
}

export async function listMembers(acc: Access, now = new Date()): Promise<MemberDto[]> {
  const db = await getDb();
  const rows = await db.select().from(communityMembers).where(eq(communityMembers.hengeId, acc.henge.id)).orderBy(asc(communityMembers.joinedAt));
  const cards = await actorCards(db, rows.map((r) => ({ type: r.actorType, id: r.actorId })));
  const pres = await db.select().from(communityPresence).where(eq(communityPresence.hengeId, acc.henge.id));
  const pmap = new Map(pres.map((p) => [p.actorId, p]));
  return rows.map((r) => ({
    actor: cards.get(r.actorId)!,
    roles: r.roles,
    nickname: r.nickname,
    joined_at: r.joinedAt.toISOString(),
    presence: presenceOf(pmap.get(r.actorId), r.actorType, now),
  }));
}

async function memberRow(db: Exec, hengeId: string, actorId: string) {
  if (!isUuid(actorId)) throw notFound('member');
  const [m] = await db.select().from(communityMembers).where(and(eq(communityMembers.hengeId, hengeId), eq(communityMembers.actorId, actorId))).limit(1);
  if (!m) throw notFound('member');
  return m;
}
export { memberRow };

/** Changes a member's roles. Owner only (or a role with `manage_roles`); `owner` and `agent` are fixed. */
export async function setMemberRoles(acc: Access, actorId: string, roles: string[], now = new Date()) {
  requireCap(acc, 'manage_roles', 'Only the owner can change roles.');
  const db = await getDb();
  const target = await memberRow(db, acc.henge.id, actorId);
  const { rows } = await roleMaps(db, acc.henge.id);
  const known = new Set(rows.map((r) => r.key));
  const next = [...new Set(roles)];
  if (!next.length) throw invalid('roles_required', 'A member needs at least one role.');
  for (const r of next) if (!known.has(r)) throw invalid('unknown_role', `No role named ${r}.`);
  if (next.includes('owner') !== target.roles.includes('owner')) throw forbidden('owner_fixed', 'The owner role cannot be given or taken here.');
  if (target.actorType === 'agent' && !next.includes('agent')) throw invalid('agent_role_fixed', 'Agents always have the agent role.');
  if (target.actorType === 'human' && next.includes('agent')) throw invalid('agent_role_fixed', 'Only agents have the agent role.');
  if (target.actorId !== acc.actor.id && rank(target.roles) >= rank(acc.roles)) throw forbidden('outranked', 'You cannot change the roles of someone at or above your rank.');
  const [row] = await db.update(communityMembers).set({ roles: next }).where(and(eq(communityMembers.hengeId, acc.henge.id), eq(communityMembers.actorId, actorId))).returning();
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'member.roles_changed', targetType: target.actorType, targetId: actorId, payload: { from: target.roles, to: next } }, now);
  await emit(db, { hengeId: acc.henge.id, kind: 'member.updated', payload: { actor_id: actorId, roles: next } }, now);
  return row!;
}

export async function setNickname(acc: Access, nickname: string | null) {
  const clean = nickname?.trim() ?? null;
  if (clean !== null && (clean.length < 1 || [...clean].length > 32)) throw invalid('nickname_invalid', 'Nicknames are 1 to 32 characters.');
  const db = await getDb();
  await db.update(communityMembers).set({ nickname: clean }).where(and(eq(communityMembers.hengeId, acc.henge.id), eq(communityMembers.actorId, acc.actor.id)));
  await emit(db, { hengeId: acc.henge.id, kind: 'member.updated', payload: { actor_id: acc.actor.id, nickname: clean } });
}

/* ---------------------------------------------------------------------------------------------- */
/* Roles                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export type RoleDto = { key: string; name: string; builtin: boolean; position: number; perms: FullPerms; capabilities: string[] };

const fullPerms = (p: PermSet): FullPerms => Object.fromEntries(CHANNEL_PERMS.map((k) => [k, p[k] === true])) as FullPerms;

export async function listRoles(acc: Access): Promise<RoleDto[]> {
  const { rows } = await roleMaps(await getDb(), acc.henge.id);
  return rows.sort((a, b) => a.position - b.position).map((r) => ({ key: r.key, name: r.name, builtin: r.builtin, position: r.position, perms: fullPerms(r.perms), capabilities: r.capabilities }));
}

const ROLE_KEY = /^[a-z][a-z0-9_]{1,23}$/;

function cleanPerms(p: unknown): PermSet {
  const out: PermSet = {};
  if (!p || typeof p !== 'object') return out;
  for (const k of CHANNEL_PERMS) {
    const v = (p as Record<string, unknown>)[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

const GRANTABLE_CAPS = ['moderate', 'pin', 'slow_mode', 'timeout', 'kick', 'ban', 'read_audit_log', 'review_reports', 'revoke_agent_tokens', 'manage_channels', 'bulk_delete'];

export async function createRole(acc: Access, input: { key: string; name: string; perms?: unknown; capabilities?: string[] }, now = new Date()) {
  requireCap(acc, 'manage_roles', 'Only the owner can create roles.');
  if (!ROLE_KEY.test(input.key) || (BUILTIN_ROLES as readonly string[]).includes(input.key) || ['everyone', 'here'].includes(input.key)) {
    throw invalid('role_key_invalid', 'Role keys are 2 to 24 characters from a to z, digits and underscores, and cannot reuse a built-in name.');
  }
  const caps = (input.capabilities ?? []).filter((c) => GRANTABLE_CAPS.includes(c));
  const db = await getDb();
  const { rows } = await roleMaps(db, acc.henge.id);
  if (rows.some((r) => r.key === input.key)) throw new CommunityError(409, 'role_exists', 'A role with that key exists.');
  const perms = { ...fullPerms({ view: true, send: true, add_reactions: true, start_threads: true }), ...cleanPerms(input.perms) };
  await db.insert(communityRoles).values({ hengeId: acc.henge.id, key: input.key, name: input.name.trim().slice(0, 32) || input.key, builtin: false, position: rows.length, perms, capabilities: caps });
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'role.created', targetType: 'role', targetId: input.key, payload: { perms, capabilities: caps } }, now);
  await emit(db, { hengeId: acc.henge.id, kind: 'roles.updated', payload: { key: input.key } }, now);
}

export async function updateRole(acc: Access, key: string, input: { name?: string; perms?: unknown; capabilities?: string[] }, now = new Date()) {
  requireCap(acc, 'manage_roles', 'Only the owner can change roles.');
  if (key === 'owner') throw forbidden('owner_fixed', 'The owner role always has every permission.');
  const db = await getDb();
  const { rows } = await roleMaps(db, acc.henge.id);
  const role = rows.find((r) => r.key === key);
  if (!role) throw notFound('role');
  const patch: Partial<typeof role> = {};
  if (input.name !== undefined) patch.name = input.name.trim().slice(0, 32) || role.name;
  if (input.perms !== undefined) patch.perms = { ...role.perms, ...cleanPerms(input.perms) };
  if (input.capabilities !== undefined) patch.capabilities = input.capabilities.filter((c) => GRANTABLE_CAPS.includes(c));
  await db.update(communityRoles).set(patch).where(and(eq(communityRoles.hengeId, acc.henge.id), eq(communityRoles.key, key)));
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'role.updated', targetType: 'role', targetId: key, payload: { from: { perms: role.perms, capabilities: role.capabilities }, to: patch } }, now);
  await emit(db, { hengeId: acc.henge.id, kind: 'roles.updated', payload: { key } }, now);
}

export async function deleteRole(acc: Access, key: string, now = new Date()) {
  requireCap(acc, 'manage_roles', 'Only the owner can delete roles.');
  const db = await getDb();
  const { rows } = await roleMaps(db, acc.henge.id);
  const role = rows.find((r) => r.key === key);
  if (!role) throw notFound('role');
  if (role.builtin) throw forbidden('builtin_role', 'Built-in roles come from the .henge file and cannot be deleted.');
  await db.transaction(async (tx) => {
    await tx.execute(sql`update community_members set roles = array_remove(roles, ${key}) where henge_id = ${acc.henge.id}`);
    await tx.execute(sql`delete from community_channel_overrides where role_key = ${key} and channel_id in (select id from community_channels where henge_id = ${acc.henge.id})`);
    await tx.delete(communityRoles).where(and(eq(communityRoles.hengeId, acc.henge.id), eq(communityRoles.key, key)));
    await audit(tx, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'role.deleted', targetType: 'role', targetId: key }, now);
    await emit(tx, { hengeId: acc.henge.id, kind: 'roles.updated', payload: { key, deleted: true } }, now);
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* Channels and categories                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export type ChannelDto = {
  id: string;
  key: string;
  name: string;
  topic: string;
  type: 'text' | 'announcement' | 'agent_run';
  category_id: string | null;
  position: number;
  slow_mode_s: number;
  public: boolean;
  agents_policy: string | null;
  glyph_posts: string[];
  archived: boolean;
  my_perms: FullPerms;
};

export function channelDto(c: CommunityChannel, perms: FullPerms): ChannelDto {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    topic: c.topic,
    type: c.type,
    category_id: c.categoryId,
    position: c.position,
    slow_mode_s: c.slowModeS,
    public: c.public,
    agents_policy: c.agentsPolicy,
    glyph_posts: c.glyphPosts,
    archived: c.archivedAt !== null,
    my_perms: perms,
  };
}

/** Channels the actor can view, grouped by category. Archived channels show only to channel managers. */
export async function listChannels(acc: Access, opts: { includeArchived?: boolean } = {}) {
  const db = await getDb();
  const cats = await db.select().from(communityCategories).where(eq(communityCategories.hengeId, acc.henge.id)).orderBy(asc(communityCategories.position));
  const chans = await db.select().from(communityChannels).where(eq(communityChannels.hengeId, acc.henge.id)).orderBy(asc(communityChannels.position));
  const ids = chans.map((c) => c.id);
  const ovs = ids.length ? await db.select().from(communityChannelOverrides).where(inArray(communityChannelOverrides.channelId, ids)) : [];
  const byChannel = new Map<string, Map<string, PermSet>>();
  for (const o of ovs) {
    const m = byChannel.get(o.channelId) ?? new Map<string, PermSet>();
    m.set(o.roleKey, o.perms);
    byChannel.set(o.channelId, m);
  }
  const showArchived = opts.includeArchived && can(acc, 'manage_channels');
  const catPos = new Map(cats.map((c) => [c.id, c.position]));
  const sortKey = (c: CommunityChannel) => [c.categoryId ? (catPos.get(c.categoryId) ?? 0) : -1, c.position] as const;
  chans.sort((a, b) => {
    const [ca, pa] = sortKey(a);
    const [cb, pb] = sortKey(b);
    return ca - cb || pa - pb;
  });
  const visible = chans
    .filter((c) => showArchived || c.archivedAt === null)
    .map((c) => ({ c, perms: permsIn(acc, c, byChannel.get(c.id) ?? new Map()) }))
    .filter((x) => x.perms.view)
    .map((x) => channelDto(x.c, x.perms));
  return {
    categories: cats.map((c) => ({ id: c.id, key: c.key, name: c.name, position: c.position })),
    channels: visible,
  };
}

/** Channel ids an actor can view, for the realtime transport. */
export async function viewableChannelIds(acc: Access): Promise<Set<string>> {
  const { channels } = await listChannels(acc, { includeArchived: true });
  return new Set(channels.map((c) => c.id));
}

function slugify(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'channel';
}

const CHANNEL_TYPES = ['text', 'announcement', 'agent_run'] as const;
const SLOW_MODE_MAX_S = 6 * 3600;

function checkSlowMode(v: unknown) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > SLOW_MODE_MAX_S) throw invalid('slow_mode_invalid', 'Slow mode is a whole number of seconds from 0 to 21600.');
  return v;
}

export async function createChannel(acc: Access, input: { name: string; type?: string; category_id?: string | null; topic?: string; slow_mode_s?: number; position?: number }, now = new Date()) {
  requireCap(acc, 'manage_channels', 'Your role cannot create channels.');
  const name = input.name.trim().slice(0, 48);
  if (!name) throw invalid('channel_name_required', 'Give the channel a name.');
  const type = (input.type ?? 'text') as (typeof CHANNEL_TYPES)[number];
  if (!CHANNEL_TYPES.includes(type)) throw invalid('channel_type_invalid', 'Channel types are text, announcement and agent_run.');
  const db = await getDb();
  if (input.category_id) await categoryRow(db, acc.henge.id, input.category_id);
  const base = slugify(name);
  const existing = new Set((await db.select({ key: communityChannels.key }).from(communityChannels).where(eq(communityChannels.hengeId, acc.henge.id))).map((r) => r.key));
  let key = base;
  for (let i = 2; existing.has(key); i++) key = `${base}-${i}`;
  const [row] = await db
    .insert(communityChannels)
    .values({
      hengeId: acc.henge.id,
      categoryId: input.category_id ?? null,
      key,
      name,
      topic: (input.topic ?? '').slice(0, 1024),
      type,
      slowModeS: input.slow_mode_s === undefined ? 0 : checkSlowMode(input.slow_mode_s),
      position: input.position ?? existing.size,
      createdAt: now,
    })
    .returning();
  // New announcement and agent_run channels get the same posting defaults as seeded ones.
  if (type !== 'text') {
    const { rows } = await roleMaps(db, acc.henge.id);
    const seed = channelSeed({ id: key, type }, rows.map((r) => r.key));
    const entries = Object.entries(seed.overrides);
    if (entries.length) await db.insert(communityChannelOverrides).values(entries.map(([roleKey, perms]) => ({ channelId: row!.id, roleKey, perms })));
  }
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'channel.created', targetType: 'channel', targetId: row!.id, payload: { name, type } }, now);
  await emit(db, { hengeId: acc.henge.id, channelId: row!.id, kind: 'channel.created', payload: { channel_id: row!.id } }, now);
  return row!;
}

async function channelRow(db: Exec, hengeId: string, channelId: string) {
  if (!isUuid(channelId)) throw notFound('channel');
  const [c] = await db.select().from(communityChannels).where(and(eq(communityChannels.id, channelId), eq(communityChannels.hengeId, hengeId))).limit(1);
  if (!c) throw notFound('channel');
  return c;
}

async function categoryRow(db: Exec, hengeId: string, categoryId: string) {
  if (!isUuid(categoryId)) throw notFound('category');
  const [c] = await db.select().from(communityCategories).where(and(eq(communityCategories.id, categoryId), eq(communityCategories.hengeId, hengeId))).limit(1);
  if (!c) throw notFound('category');
  return c;
}

export type ChannelPatch = { name?: string; topic?: string; type?: string; category_id?: string | null; slow_mode_s?: number; position?: number; archived?: boolean; public?: boolean };

/** Channel settings. Slow mode alone needs `slow_mode`; everything else needs `manage_channels`. */
export async function updateChannel(acc: Access, channelId: string, patch: ChannelPatch, now = new Date()) {
  const db = await getDb();
  const ch = await channelRow(db, acc.henge.id, channelId);
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return ch;
  const slowOnly = keys.length === 1 && keys[0] === 'slow_mode_s';
  if (slowOnly) {
    if (!can(acc, 'slow_mode') && !can(acc, 'manage_channels')) throw forbidden('forbidden', 'Your role cannot set slow mode.', { needs: 'slow_mode' });
  } else requireCap(acc, 'manage_channels', 'Your role cannot change channel settings.');
  const set: Partial<CommunityChannel> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 48);
    if (!name) throw invalid('channel_name_required', 'Give the channel a name.');
    set.name = name;
  }
  if (patch.topic !== undefined) set.topic = patch.topic.slice(0, 1024);
  if (patch.type !== undefined) {
    if (!CHANNEL_TYPES.includes(patch.type as never)) throw invalid('channel_type_invalid', 'Channel types are text, announcement and agent_run.');
    set.type = patch.type as CommunityChannel['type'];
  }
  if (patch.category_id !== undefined) {
    if (patch.category_id) await categoryRow(db, acc.henge.id, patch.category_id);
    set.categoryId = patch.category_id;
  }
  if (patch.slow_mode_s !== undefined) set.slowModeS = checkSlowMode(patch.slow_mode_s);
  if (patch.position !== undefined) set.position = Math.max(0, Math.trunc(patch.position));
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? (ch.archivedAt ?? now) : null;
  if (patch.public !== undefined) set.public = patch.public;
  const [row] = await db.update(communityChannels).set(set).where(eq(communityChannels.id, ch.id)).returning();
  const actor = { type: acc.actor.type, id: acc.actor.id } as const;
  if (patch.slow_mode_s !== undefined && patch.slow_mode_s !== ch.slowModeS) {
    await audit(db, { hengeId: acc.henge.id, actor, action: 'channel.slow_mode', targetType: 'channel', targetId: ch.id, payload: { channel: ch.name, from_s: ch.slowModeS, to_s: patch.slow_mode_s } }, now);
  }
  if (patch.archived !== undefined && patch.archived !== (ch.archivedAt !== null)) {
    await audit(db, { hengeId: acc.henge.id, actor, action: patch.archived ? 'channel.archived' : 'channel.unarchived', targetType: 'channel', targetId: ch.id, payload: { channel: ch.name } }, now);
  }
  const other = keys.filter((k) => k !== 'slow_mode_s' && k !== 'archived');
  if (other.length) await audit(db, { hengeId: acc.henge.id, actor, action: 'channel.updated', targetType: 'channel', targetId: ch.id, payload: { fields: other, channel: row!.name } }, now);
  await emit(db, { hengeId: acc.henge.id, channelId: ch.id, kind: 'channel.updated', payload: { channel_id: ch.id } }, now);
  return row!;
}

export async function createCategory(acc: Access, input: { name: string; position?: number }, now = new Date()) {
  requireCap(acc, 'manage_channels', 'Your role cannot create categories.');
  const name = input.name.trim().slice(0, 48);
  if (!name) throw invalid('category_name_required', 'Give the category a name.');
  const db = await getDb();
  const existing = new Set((await db.select({ key: communityCategories.key }).from(communityCategories).where(eq(communityCategories.hengeId, acc.henge.id))).map((r) => r.key));
  const base = slugify(name);
  let key = base;
  for (let i = 2; existing.has(key); i++) key = `${base}-${i}`;
  const [row] = await db.insert(communityCategories).values({ hengeId: acc.henge.id, key, name, position: input.position ?? existing.size, createdAt: now }).returning();
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'category.created', targetType: 'category', targetId: row!.id, payload: { name } }, now);
  await emit(db, { hengeId: acc.henge.id, kind: 'channel.updated', payload: { category_id: row!.id } }, now);
  return row!;
}

export async function updateCategory(acc: Access, categoryId: string, input: { name?: string; position?: number }, now = new Date()) {
  requireCap(acc, 'manage_channels', 'Your role cannot change categories.');
  const db = await getDb();
  const cat = await categoryRow(db, acc.henge.id, categoryId);
  const set: { name?: string; position?: number } = {};
  if (input.name !== undefined) set.name = input.name.trim().slice(0, 48) || cat.name;
  if (input.position !== undefined) set.position = Math.max(0, Math.trunc(input.position));
  if (!Object.keys(set).length) return cat;
  const [row] = await db.update(communityCategories).set(set).where(eq(communityCategories.id, cat.id)).returning();
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'category.updated', targetType: 'category', targetId: cat.id, payload: set }, now);
  await emit(db, { hengeId: acc.henge.id, kind: 'channel.updated', payload: { category_id: cat.id } }, now);
  return row!;
}

/* ---------------------------------------------------------------------------------------------- */
/* Permission matrix (mockup 16)                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export type MatrixDto = {
  channel_id: string;
  roles: { key: string; name: string; effective: FullPerms; overrides: PermSet }[];
};

export async function permissionMatrix(acc: Access, channelId: string): Promise<MatrixDto> {
  if (!can(acc, 'manage_channels') && !can(acc, 'manage_roles')) throw forbidden('forbidden', 'Your role cannot see channel permissions.', { needs: 'manage_channels' });
  const db = await getDb();
  const ch = await channelRow(db, acc.henge.id, channelId);
  const ov = await channelOverrides(db, ch.id);
  const { rows, defaults } = await roleMaps(db, acc.henge.id);
  return {
    channel_id: ch.id,
    roles: rows
      .sort((a, b) => a.position - b.position)
      .map((r) => ({ key: r.key, name: r.name, effective: effectivePerms([r.key], defaults, ov, { public: ch.public, archived: ch.archivedAt !== null }), overrides: ov.get(r.key) ?? {} })),
  };
}

/** Sets channel overrides per role. `null` clears one permission back to the role default. */
export async function setPermissionOverrides(acc: Access, channelId: string, input: Record<string, Record<string, boolean | null>>, now = new Date()) {
  requireCap(acc, 'manage_channels', 'Your role cannot change channel permissions.');
  const db = await getDb();
  const ch = await channelRow(db, acc.henge.id, channelId);
  const { rows } = await roleMaps(db, acc.henge.id);
  const known = new Set(rows.map((r) => r.key));
  const current = await channelOverrides(db, ch.id);
  const changes: Record<string, { from: PermSet; to: PermSet }> = {};
  for (const [role, perms] of Object.entries(input)) {
    if (!known.has(role)) throw invalid('unknown_role', `No role named ${role}.`);
    if (role === 'owner') throw forbidden('owner_fixed', 'The owner role always has every permission.');
    const next: PermSet = { ...(current.get(role) ?? {}) };
    for (const [k, v] of Object.entries(perms ?? {})) {
      if (!(CHANNEL_PERMS as readonly string[]).includes(k)) throw invalid('unknown_permission', `No permission named ${k}.`);
      if (v === null) delete next[k as keyof PermSet];
      else if (typeof v === 'boolean') next[k as keyof PermSet] = v;
      else throw invalid('permission_value_invalid', 'Permission values are true, false or null.');
    }
    changes[role] = { from: current.get(role) ?? {}, to: next };
    if (Object.keys(next).length) {
      await db.insert(communityChannelOverrides).values({ channelId: ch.id, roleKey: role, perms: next }).onConflictDoUpdate({ target: [communityChannelOverrides.channelId, communityChannelOverrides.roleKey], set: { perms: next } });
    } else {
      await db.delete(communityChannelOverrides).where(and(eq(communityChannelOverrides.channelId, ch.id), eq(communityChannelOverrides.roleKey, role)));
    }
  }
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'channel.permissions_changed', targetType: 'channel', targetId: ch.id, payload: { channel: ch.name, changes } }, now);
  await emit(db, { hengeId: acc.henge.id, channelId: ch.id, kind: 'channel.updated', payload: { channel_id: ch.id } }, now);
  return permissionMatrix(acc, ch.id);
}

/* ---------------------------------------------------------------------------------------------- */
/* Agents in a Henge                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/** Adds one of the caller's agents to a Henge with the `agent` role and returns its token (shown once). */
export async function addAgentToHenge(acc: Access, agentId: string, now = new Date()) {
  if (acc.actor.type !== 'human') throw forbidden('humans_only', 'Agents are added by their owner.');
  if (acc.roles.length === 1 && acc.roles[0] === 'observer') throw forbidden('observers_cannot_add_agents', 'Observers cannot add agents.');
  const db = await getDb();
  if (!isUuid(agentId)) throw notFound('agent');
  const [agent] = await db.select().from(communityAgents).where(and(eq(communityAgents.id, agentId), eq(communityAgents.ownerAccountId, acc.actor.id), isNull(communityAgents.deletedAt))).limit(1);
  if (!agent) throw notFound('agent');
  const ban = await activeBan(db, acc.henge.id, [agent.id]);
  if (ban) throw forbidden('banned', 'This agent is banned from this Henge.');
  const role = acc.file.community?.defaults?.agents_role ?? 'agent';
  const roles = [...new Set(['agent', role])];
  await db.insert(communityMembers).values({ hengeId: acc.henge.id, actorId: agent.id, actorType: 'agent', ownerAccountId: acc.actor.id, roles, joinedAt: now }).onConflictDoNothing();
  await emit(db, { hengeId: acc.henge.id, kind: 'member.joined', payload: { actor_id: agent.id, actor_type: 'agent', roles } }, now);
  return issueAgentToken(acc.henge.id, agent.id, now);
}

async function issueAgentToken(hengeId: string, agentId: string, now: Date) {
  const db = await getDb();
  const token = newAgentToken();
  await db
    .update(communityAgentTokens)
    .set({ revokedAt: now, revokedByType: 'system', revokedById: 'rotated' })
    .where(and(eq(communityAgentTokens.hengeId, hengeId), eq(communityAgentTokens.agentId, agentId), isNull(communityAgentTokens.revokedAt)));
  await db.insert(communityAgentTokens).values({ hengeId, agentId, tokenHash: hashAgentToken(token), createdAt: now });
  return { agent_id: agentId, henge_id: hengeId, token };
}

/** A new token for an agent already in the Henge (the old one stops working). Owner of the agent only. */
export async function rotateAgentToken(acc: Access, agentId: string, now = new Date()) {
  const db = await getDb();
  const m = await memberRow(db, acc.henge.id, agentId);
  if (m.actorType !== 'agent' || m.ownerAccountId !== acc.actor.id || acc.actor.type !== 'human') throw notFound('agent');
  return issueAgentToken(acc.henge.id, agentId, now);
}

/** Revokes an agent's token in this Henge: its owner, or a role with `revoke_agent_tokens` (mockup 17). */
export async function revokeAgentToken(acc: Access, agentId: string, reason: string | null, now = new Date()) {
  const db = await getDb();
  const m = await memberRow(db, acc.henge.id, agentId);
  if (m.actorType !== 'agent') throw notFound('agent');
  const isOwner = acc.actor.type === 'human' && m.ownerAccountId === acc.actor.id;
  if (!isOwner) requireCap(acc, 'revoke_agent_tokens', 'Your role cannot revoke agent tokens.');
  const revoked = await db
    .update(communityAgentTokens)
    .set({ revokedAt: now, revokedByType: acc.actor.type, revokedById: acc.actor.id })
    .where(and(eq(communityAgentTokens.hengeId, acc.henge.id), eq(communityAgentTokens.agentId, agentId), isNull(communityAgentTokens.revokedAt)))
    .returning({ id: communityAgentTokens.id });
  await audit(db, { hengeId: acc.henge.id, actor: { type: acc.actor.type, id: acc.actor.id }, action: 'agent.token_revoked', targetType: 'agent', targetId: agentId, reason, payload: { tokens: revoked.length } }, now);
  await emit(db, { hengeId: acc.henge.id, kind: 'member.updated', payload: { actor_id: agentId, token_revoked: true } }, now);
  return { revoked: revoked.length };
}

/** Other members who hold a permission in a channel (used to address held messages to moderators). */
export async function membersWithPerm(hengeId: string, channel: CommunityChannel, perm: keyof FullPerms, excludeId?: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select().from(communityMembers).where(excludeId ? and(eq(communityMembers.hengeId, hengeId), ne(communityMembers.actorId, excludeId)) : eq(communityMembers.hengeId, hengeId));
  const { defaults } = await roleMaps(db, hengeId);
  const ov = await channelOverrides(db, channel.id);
  return rows.filter((r) => effectivePerms(r.roles, defaults, ov, { public: channel.public, archived: false })[perm]).map((r) => r.actorId);
}
