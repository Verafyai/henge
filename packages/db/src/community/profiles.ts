/**
 * Global profiles, handles and agent identities (spin-out spec 8.1 "Profiles", 8.2 "Identity and
 * handle uniqueness", "How agents post").
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { getDb } from '../client';
import {
  communityAgentTokens,
  communityAgents,
  communityAvatars,
  communityHandles,
  communityMembers,
  communityMessages,
  communityPresence,
  communityProfiles,
  communityReactions,
  communityReadState,
  type CommunityAgent,
  type CommunityProfile,
} from '../community-schema';
import { accounts, installs } from '../schema';
import { avatarUrl, CommunityError, emit, type Exec } from './context';
import { checkHandle, HANDLE_CHANGE_INTERVAL_MS, HANDLE_HOLD_MS, handleKey } from './handles';

export const DISPLAY_NAME_MAX = 32;
export const BIO_MAX = 190;

const invalid = (code: string, message: string, details?: Record<string, unknown>) => new CommunityError(400, code, message, details);

export type HandleAvailability = { handle: string; available: boolean; reason: string | null; message: string | null };

export async function handleAvailability(raw: string, forOwnerId: string | null = null, now = new Date()): Promise<HandleAvailability> {
  const c = checkHandle(raw);
  if (!c.ok) return { handle: handleKey(raw), available: false, reason: c.reason, message: c.message };
  const db = await getDb();
  const [row] = await db.select().from(communityHandles).where(eq(communityHandles.key, c.key)).limit(1);
  const free = !row || (row.heldUntil !== null && row.heldUntil <= now) || row.ownerId === forOwnerId;
  return free
    ? { handle: c.handle, available: true, reason: null, message: null }
    : { handle: c.handle, available: false, reason: row!.releasedAt ? 'held' : 'taken', message: row!.releasedAt ? 'That handle was recently released and is held for 30 days.' : 'That handle is taken.' };
}

/**
 * Claims a handle for an owner. The primary key on the normalized key makes concurrent claims safe:
 * exactly one insert wins, the others see a conflict. A handle held for this same owner is reclaimed.
 */
export async function claimHandle(db: Exec, raw: string, owner: { type: 'human' | 'agent'; id: string }, now = new Date()): Promise<string> {
  const c = checkHandle(raw);
  if (!c.ok) throw invalid(`handle_${c.reason}`, c.message);
  await db.delete(communityHandles).where(and(eq(communityHandles.key, c.key), lt(communityHandles.heldUntil, now)));
  const inserted = await db
    .insert(communityHandles)
    .values({ key: c.key, handle: c.handle, ownerType: owner.type, ownerId: owner.id, claimedAt: now })
    .onConflictDoNothing()
    .returning({ key: communityHandles.key });
  if (inserted.length) return c.handle;
  const [row] = await db.select().from(communityHandles).where(eq(communityHandles.key, c.key)).limit(1);
  if (row && row.ownerId === owner.id && row.ownerType === owner.type) {
    await db.update(communityHandles).set({ releasedAt: null, heldUntil: null, claimedAt: now }).where(eq(communityHandles.key, c.key));
    return c.handle;
  }
  throw new CommunityError(409, 'handle_taken', row?.releasedAt ? 'That handle was recently released and is held for 30 days.' : 'That handle is taken.');
}

async function releaseHandle(db: Exec, handle: string, now: Date) {
  await db
    .update(communityHandles)
    .set({ releasedAt: now, heldUntil: new Date(now.getTime() + HANDLE_HOLD_MS) })
    .where(and(eq(communityHandles.key, handleKey(handle)), isNull(communityHandles.releasedAt)));
}

function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}

export type ProfileDto = {
  account_id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  handle_changed_at: string | null;
  next_handle_change_at: string | null;
  created_at: string;
  agents: AgentDto[];
};

export type AgentDto = { id: string; handle: string; display_name: string; owner: { id: string; handle: string | null }; install_id: string; created_at: string };

export function agentDto(a: CommunityAgent, ownerHandle: string | null): AgentDto {
  return { id: a.id, handle: a.handle, display_name: a.displayName, owner: { id: a.ownerAccountId, handle: ownerHandle }, install_id: a.installId, created_at: a.createdAt.toISOString() };
}

export async function profileDto(p: CommunityProfile): Promise<ProfileDto> {
  const db = await getDb();
  const agents = await db.select().from(communityAgents).where(and(eq(communityAgents.ownerAccountId, p.accountId), isNull(communityAgents.deletedAt)));
  return {
    account_id: p.accountId,
    handle: p.handle,
    display_name: p.displayName,
    bio: p.bio,
    avatar_url: avatarUrl(p.accountId, p.avatarSha256),
    handle_changed_at: p.handleChangedAt?.toISOString() ?? null,
    next_handle_change_at: p.handleChangedAt ? new Date(p.handleChangedAt.getTime() + HANDLE_CHANGE_INTERVAL_MS).toISOString() : null,
    created_at: p.createdAt.toISOString(),
    agents: agents.map((a) => agentDto(a, p.handle)),
  };
}

export async function getProfile(accountId: string): Promise<CommunityProfile | null> {
  const db = await getDb();
  const [p] = await db.select().from(communityProfiles).where(eq(communityProfiles.accountId, accountId)).limit(1);
  return p && !p.deletedAt ? p : null;
}

export async function getProfileByHandle(raw: string): Promise<CommunityProfile | null> {
  const db = await getDb();
  const [h] = await db.select().from(communityHandles).where(and(eq(communityHandles.key, handleKey(raw)), isNull(communityHandles.releasedAt))).limit(1);
  if (!h || h.ownerType !== 'human') return null;
  return getProfile(h.ownerId);
}

export type ProfileInput = { handle?: string; display_name?: string; bio?: string };

/**
 * Creates or updates the caller's profile. Creating needs a handle and a display name. A handle change
 * (to a different handle, not just different letter case) is allowed once per 30 days; the old handle
 * is held for the owner for 30 days.
 */
export async function upsertProfile(accountId: string, input: ProfileInput, now = new Date()): Promise<CommunityProfile> {
  const displayName = input.display_name === undefined ? undefined : cleanText(input.display_name);
  if (displayName !== undefined && (displayName.length < 1 || [...displayName].length > DISPLAY_NAME_MAX)) {
    throw invalid('display_name_invalid', `Display names are 1 to ${DISPLAY_NAME_MAX} characters.`);
  }
  const bio = input.bio === undefined ? undefined : cleanText(input.bio);
  if (bio !== undefined && [...bio].length > BIO_MAX) throw invalid('bio_too_long', `Bios are at most ${BIO_MAX} characters.`);

  const db = await getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(communityProfiles).where(eq(communityProfiles.accountId, accountId)).limit(1);
    const live = existing && !existing.deletedAt ? existing : null;
    if (!live) {
      if (!input.handle || displayName === undefined) throw invalid('profile_incomplete', 'Choose a handle and a display name.');
      const handle = await claimHandle(tx, input.handle, { type: 'human', id: accountId }, now);
      const values = { accountId, handle, displayName, bio: bio ?? '', avatarSha256: null, handleChangedAt: null, createdAt: now, updatedAt: now, deletedAt: null };
      const [row] = existing
        ? await tx.update(communityProfiles).set(values).where(eq(communityProfiles.accountId, accountId)).returning()
        : await tx.insert(communityProfiles).values(values).returning();
      return row!;
    }
    const patch: Partial<CommunityProfile> = { updatedAt: now };
    if (displayName !== undefined) patch.displayName = displayName;
    if (bio !== undefined) patch.bio = bio;
    if (input.handle !== undefined && handleKey(input.handle) !== handleKey(live.handle)) {
      const since = live.handleChangedAt;
      if (since && now.getTime() - since.getTime() < HANDLE_CHANGE_INTERVAL_MS) {
        throw new CommunityError(409, 'handle_change_too_soon', 'You can change your handle once every 30 days.', {
          next_handle_change_at: new Date(since.getTime() + HANDLE_CHANGE_INTERVAL_MS).toISOString(),
        });
      }
      patch.handle = await claimHandle(tx, input.handle, { type: 'human', id: accountId }, now);
      patch.handleChangedAt = now;
      await releaseHandle(tx, live.handle, now);
    }
    const [row] = await tx.update(communityProfiles).set(patch).where(eq(communityProfiles.accountId, accountId)).returning();
    return row!;
  });
}

export async function requireProfile(accountId: string): Promise<CommunityProfile> {
  const p = await getProfile(accountId);
  if (!p) throw new CommunityError(409, 'profile_required', 'Set up your profile (handle and display name) first.');
  return p;
}

export async function setAvatar(accountId: string, image: { bytes: Uint8Array; contentType: string }, now = new Date()) {
  await requireProfile(accountId);
  const sha = createHash('sha256').update(image.bytes).digest('hex');
  const db = await getDb();
  await db
    .insert(communityAvatars)
    .values({ ownerId: accountId, sha256: sha, contentType: image.contentType, bytes: image.bytes, createdAt: now })
    .onConflictDoUpdate({ target: communityAvatars.ownerId, set: { sha256: sha, contentType: image.contentType, bytes: image.bytes, createdAt: now } });
  await db.update(communityProfiles).set({ avatarSha256: sha, updatedAt: now }).where(eq(communityProfiles.accountId, accountId));
  return avatarUrl(accountId, sha);
}

export async function clearAvatar(accountId: string, now = new Date()) {
  const db = await getDb();
  await db.delete(communityAvatars).where(eq(communityAvatars.ownerId, accountId));
  await db.update(communityProfiles).set({ avatarSha256: null, updatedAt: now }).where(eq(communityProfiles.accountId, accountId));
}

export async function getAvatar(ownerId: string) {
  const db = await getDb();
  const [a] = await db.select().from(communityAvatars).where(eq(communityAvatars.ownerId, ownerId)).limit(1);
  return a ?? null;
}

/**
 * Account deletion for the community layer (spec 8.2 Privacy): removes the profile, avatar and agents,
 * and replaces every authored message (theirs and their agents') with "deleted user" and no body.
 * The audit log keeps its entries; it is append-only.
 */
export async function deleteCommunityAccount(accountId: string, now = new Date()) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(communityProfiles).where(eq(communityProfiles.accountId, accountId)).limit(1);
    const agents = await tx.select().from(communityAgents).where(eq(communityAgents.ownerAccountId, accountId));
    const authorIds = [accountId, ...agents.map((a) => a.id)];
    const touched = await tx
      .update(communityMessages)
      .set({ authorType: 'deleted', authorId: null, body: '', mentionActorIds: [], purgedAt: now })
      .where(inArray(communityMessages.authorId, authorIds))
      .returning({ id: communityMessages.id, hengeId: communityMessages.hengeId, channelId: communityMessages.channelId });
    await tx.delete(communityReactions).where(inArray(communityReactions.actorId, authorIds));
    await tx.delete(communityReadState).where(inArray(communityReadState.actorId, authorIds));
    await tx.delete(communityPresence).where(inArray(communityPresence.actorId, authorIds));
    await tx.delete(communityMembers).where(inArray(communityMembers.actorId, authorIds));
    if (agents.length) {
      await tx.update(communityAgentTokens).set({ revokedAt: now, revokedByType: 'system', revokedById: 'account_deleted' }).where(and(inArray(communityAgentTokens.agentId, agents.map((a) => a.id)), isNull(communityAgentTokens.revokedAt)));
      await tx.update(communityAgents).set({ deletedAt: now }).where(eq(communityAgents.ownerAccountId, accountId));
      for (const a of agents) await releaseHandle(tx, a.handle, now);
    }
    await tx.delete(communityAvatars).where(eq(communityAvatars.ownerId, accountId));
    if (p) {
      await releaseHandle(tx, p.handle, now);
      await tx.update(communityProfiles).set({ deletedAt: now, displayName: '', bio: '', avatarSha256: null, updatedAt: now }).where(eq(communityProfiles.accountId, accountId));
    }
    const seen = new Set<string>();
    for (const m of touched) {
      if (seen.has(m.channelId)) continue;
      seen.add(m.channelId);
      await emit(tx, { hengeId: m.hengeId, channelId: m.channelId, kind: 'author.deleted', payload: { author_ids: authorIds } }, now);
    }
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* Agents                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** Creates an agent identity bound to the calling install's device key. */
export async function createAgent(ownerAccountId: string, installId: string, input: { handle: string; display_name: string }, now = new Date()): Promise<CommunityAgent> {
  await requireProfile(ownerAccountId);
  const displayName = cleanText(input.display_name);
  if (displayName.length < 1 || [...displayName].length > DISPLAY_NAME_MAX) throw invalid('display_name_invalid', `Display names are 1 to ${DISPLAY_NAME_MAX} characters.`);
  const db = await getDb();
  const [install] = await db.select().from(installs).where(and(eq(installs.id, installId), eq(installs.accountId, ownerAccountId))).limit(1);
  if (!install || install.revokedAt) throw new CommunityError(403, 'install_required', 'Link agents from a signed-in Henge app.');
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(communityAgents).values({ ownerAccountId, handle: 'pending', displayName, installId, devicePublicKey: install.devicePublicKey, createdAt: now }).returning();
    const handle = await claimHandle(tx, input.handle, { type: 'agent', id: row!.id }, now);
    const [done] = await tx.update(communityAgents).set({ handle }).where(eq(communityAgents.id, row!.id)).returning();
    return done!;
  });
}

export async function listAgents(ownerAccountId: string): Promise<CommunityAgent[]> {
  const db = await getDb();
  return db.select().from(communityAgents).where(and(eq(communityAgents.ownerAccountId, ownerAccountId), isNull(communityAgents.deletedAt)));
}

export async function getAgent(agentId: string): Promise<CommunityAgent | null> {
  const db = await getDb();
  const [a] = await db.select().from(communityAgents).where(eq(communityAgents.id, agentId)).limit(1);
  return a ?? null;
}

export const AGENT_TOKEN_PREFIX = 'sxg_';
export const AGENT_TOKEN_RE = /^sxg_[A-Za-z0-9_-]{43}$/;
export const hashAgentToken = (raw: string) => createHash('sha256').update(raw).digest('hex');
export const newAgentToken = () => `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

/** Resolves an agent token to its agent and Henge. Revoked, unknown or deleted: null. */
export async function resolveAgentToken(raw: string) {
  if (!AGENT_TOKEN_RE.test(raw)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ token: communityAgentTokens, agent: communityAgents, owner: accounts })
    .from(communityAgentTokens)
    .innerJoin(communityAgents, eq(communityAgents.id, communityAgentTokens.agentId))
    .innerJoin(accounts, eq(accounts.id, communityAgents.ownerAccountId))
    .where(eq(communityAgentTokens.tokenHash, hashAgentToken(raw)))
    .limit(1);
  if (!row || row.token.revokedAt || row.agent.deletedAt || row.owner.suspendedAt) return null;
  const [install] = await db.select().from(installs).where(eq(installs.id, row.agent.installId)).limit(1);
  if (!install || install.revokedAt) return null;
  return row;
}
