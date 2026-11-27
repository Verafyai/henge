/**
 * Shared community plumbing: actors, access checks, the audit log and the realtime event feed.
 */
import type { HengeV1 } from '@swarm-explorer/schema';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { getDb, type Db } from '../client';
import {
  communityAgents,
  communityAuditLog,
  communityBans,
  communityChannelOverrides,
  communityChannels,
  communityEvents,
  communityMembers,
  communityProfiles,
  communityRoles,
  communityTimeouts,
  henges,
  type CommunityChannel,
  type CommunityMember,
  type Henge,
  type PermSet,
} from '../community-schema';
import { MembershipError } from '../errors';
import { MODERATION_GLYPH_ID, MODERATION_GLYPH_NAME } from './config';
import { effectivePerms, hasCapability, type Capability, type FullPerms } from './perms';
import { ulid } from './ulid';

export class CommunityError extends MembershipError {}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Exec = Db | Tx;

/** Who is acting. For agents `accountId` is the owner's account. */
export type Actor = { type: 'human' | 'agent'; id: string; accountId: string; accountCreatedAt: Date };
export type ActorRef = { type: 'human' | 'agent' | 'glyph' | 'system'; id: string };
export const GLYPH_ACTOR: ActorRef = { type: 'glyph', id: MODERATION_GLYPH_ID };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export const notFound = (what: string) => new CommunityError(404, `${what}_not_found`, `No such ${what.replace(/_/g, ' ')}.`);
export const forbidden = (code: string, message: string, details?: Record<string, unknown>) => new CommunityError(403, code, message, details);

export async function loadHenge(db: Exec, hengeId: string): Promise<Henge> {
  if (!isUuid(hengeId)) throw notFound('henge');
  const [h] = await db.select().from(henges).where(eq(henges.id, hengeId)).limit(1);
  if (!h) throw notFound('henge');
  return h;
}

export type Access = {
  actor: Actor;
  henge: Henge;
  file: HengeV1;
  member: CommunityMember;
  roles: string[];
  roleDefaults: Map<string, PermSet>;
  roleCaps: Map<string, string[]>;
};

export async function roleMaps(db: Exec, hengeId: string) {
  const rows = await db.select().from(communityRoles).where(eq(communityRoles.hengeId, hengeId));
  return { rows, defaults: new Map(rows.map((r) => [r.key, r.perms])), caps: new Map(rows.map((r) => [r.key, r.capabilities])) };
}

/** Active ban on an actor or, for agents, on the owning account (spec 8.2: bans cover all of an account's agents). */
export async function activeBan(db: Exec, hengeId: string, ids: string[]) {
  const [b] = await db
    .select()
    .from(communityBans)
    .where(and(eq(communityBans.hengeId, hengeId), inArray(communityBans.actorId, ids), isNull(communityBans.liftedAt)))
    .limit(1);
  return b ?? null;
}

export async function activeTimeout(db: Exec, hengeId: string, ids: string[], now = new Date()) {
  const rows = await db
    .select()
    .from(communityTimeouts)
    .where(and(eq(communityTimeouts.hengeId, hengeId), inArray(communityTimeouts.actorId, ids), gt(communityTimeouts.until, now), isNull(communityTimeouts.clearedAt)));
  if (!rows.length) return null;
  return rows.reduce((a, b) => (a.until > b.until ? a : b));
}

export const actorIds = (a: Actor) => (a.type === 'agent' ? [a.id, a.accountId] : [a.id]);

/** The actor's membership in a Henge. Not a member: 403. Banned: 403 with the ban's appeal window. */
export async function access(actor: Actor, hengeId: string): Promise<Access> {
  const db = await getDb();
  const henge = await loadHenge(db, hengeId);
  const ban = await activeBan(db, henge.id, actorIds(actor));
  if (ban) throw forbidden('banned', 'You are banned from this Henge.', { appeal_until: ban.appealUntil?.toISOString() ?? null });
  const [member] = await db
    .select()
    .from(communityMembers)
    .where(and(eq(communityMembers.hengeId, henge.id), eq(communityMembers.actorId, actor.id)))
    .limit(1);
  if (!member) throw forbidden('not_a_member', 'Join this Henge first.');
  const { defaults, caps } = await roleMaps(db, henge.id);
  return { actor, henge, file: henge.hengeFile as HengeV1, member, roles: member.roles, roleDefaults: defaults, roleCaps: caps };
}

export function can(acc: Access, cap: Capability): boolean {
  return hasCapability(acc.roles, acc.roleCaps, cap);
}

export function requireCap(acc: Access, cap: Capability, message = 'Your role cannot do that here.') {
  if (!can(acc, cap)) throw forbidden('forbidden', message, { needs: cap });
}

export async function channelOverrides(db: Exec, channelId: string) {
  const rows = await db.select().from(communityChannelOverrides).where(eq(communityChannelOverrides.channelId, channelId));
  return new Map(rows.map((r) => [r.roleKey, r.perms]));
}

export function permsIn(acc: Access, channel: CommunityChannel, overrides: Map<string, PermSet>): FullPerms {
  return effectivePerms(acc.roles, acc.roleDefaults, overrides, { public: channel.public, archived: channel.archivedAt !== null });
}

/** A channel the actor can see. Channels they cannot view look missing. */
export async function channelAccess(acc: Access, channelId: string) {
  if (!isUuid(channelId)) throw notFound('channel');
  const db = await getDb();
  const [channel] = await db
    .select()
    .from(communityChannels)
    .where(and(eq(communityChannels.id, channelId), eq(communityChannels.hengeId, acc.henge.id)))
    .limit(1);
  if (!channel) throw notFound('channel');
  const overrides = await channelOverrides(db, channel.id);
  const perms = permsIn(acc, channel, overrides);
  if (!perms.view) throw notFound('channel');
  return { channel, overrides, perms };
}

export type AuditEntry = {
  hengeId: string;
  actor: ActorRef;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown>;
};

/** Appends to the audit log (append-only: a trigger refuses UPDATE, DELETE and TRUNCATE). */
export async function audit(db: Exec, e: AuditEntry, now = new Date()) {
  const id = ulid(now.getTime());
  await db.insert(communityAuditLog).values({
    id,
    hengeId: e.hengeId,
    actorType: e.actor.type,
    actorId: e.actor.id,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    reason: e.reason ?? null,
    payload: e.payload ?? {},
    createdAt: now,
  });
  await emit(db, { hengeId: e.hengeId, kind: 'audit.appended', payload: { id, action: e.action }, audienceCap: 'read_audit_log' }, now);
  return id;
}

export type EventInput = {
  hengeId: string;
  channelId?: string | null;
  kind: string;
  payload: Record<string, unknown>;
  /** Only these actors receive it. */
  audience?: string[] | null;
  /** Only members holding this capability receive it (resolved by the transport). */
  audienceCap?: Capability;
};

/** Writes one realtime event. The SSE transport delivers it to subscribers who may see it. */
export async function emit(db: Exec, e: EventInput, now = new Date()) {
  const id = ulid(now.getTime());
  await db.insert(communityEvents).values({
    id,
    hengeId: e.hengeId,
    channelId: e.channelId ?? null,
    kind: e.kind,
    payload: e.audienceCap ? { ...e.payload, _cap: e.audienceCap } : e.payload,
    audience: e.audience ?? null,
    createdAt: now,
  });
  return id;
}

export type ActorCard = {
  id: string;
  type: 'human' | 'agent' | 'glyph' | 'system' | 'deleted';
  handle: string | null;
  display_name: string;
  avatar_url: string | null;
  owner: { id: string; handle: string | null } | null;
};

export const DELETED_USER = 'deleted user';

export function avatarUrl(ownerId: string, sha: string | null): string | null {
  return sha ? `/v1/avatars/${ownerId}?v=${sha.slice(0, 16)}` : null;
}

/** Display cards for a set of actors (profiles, agents with their owner, Glyphs). */
export async function actorCards(db: Exec, refs: { type: string; id: string | null }[]): Promise<Map<string, ActorCard>> {
  const out = new Map<string, ActorCard>();
  const humanIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const r of refs) {
    if (!r.id) continue;
    if (r.type === 'human') humanIds.add(r.id);
    else if (r.type === 'agent') agentIds.add(r.id);
    else if (r.type === 'glyph') out.set(r.id, { id: r.id, type: 'glyph', handle: null, display_name: r.id === MODERATION_GLYPH_ID ? MODERATION_GLYPH_NAME : r.id, avatar_url: null, owner: null });
    else if (r.type === 'system') out.set(r.id, { id: r.id, type: 'system', handle: null, display_name: 'System', avatar_url: null, owner: null });
  }
  const agents = agentIds.size ? await db.select().from(communityAgents).where(inArray(communityAgents.id, [...agentIds])) : [];
  for (const a of agents) humanIds.add(a.ownerAccountId);
  const profiles = humanIds.size ? await db.select().from(communityProfiles).where(inArray(communityProfiles.accountId, [...humanIds])) : [];
  const byAccount = new Map(profiles.filter((p) => !p.deletedAt).map((p) => [p.accountId, p]));
  for (const id of humanIds) {
    const p = byAccount.get(id);
    out.set(
      id,
      p
        ? { id, type: 'human', handle: p.handle, display_name: p.displayName, avatar_url: avatarUrl(id, p.avatarSha256), owner: null }
        : { id, type: 'deleted', handle: null, display_name: DELETED_USER, avatar_url: null, owner: null },
    );
  }
  for (const a of agents) {
    const owner = byAccount.get(a.ownerAccountId);
    out.set(
      a.id,
      a.deletedAt
        ? { id: a.id, type: 'deleted', handle: null, display_name: DELETED_USER, avatar_url: null, owner: null }
        : { id: a.id, type: 'agent', handle: a.handle, display_name: a.displayName, avatar_url: null, owner: { id: a.ownerAccountId, handle: owner?.handle ?? null } },
    );
  }
  return out;
}

export function deletedCard(id: string | null): ActorCard {
  return { id: id ?? 'deleted', type: 'deleted', handle: null, display_name: DELETED_USER, avatar_url: null, owner: null };
}
