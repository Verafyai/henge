/**
 * Community permissions (spin-out spec 8.1 "Permissions" and "Roles", mockup 16). Pure functions, so
 * every rule is unit tested without a database.
 *
 * Model: each role has Henge-wide channel defaults (derived from the `.henge` file's
 * `governance.roles.<role>.can`) and Henge-wide capabilities. Channel overrides beat the defaults per
 * role. An actor's permission in a channel is the union over their roles. The owner always has every
 * permission, so a Henge can never lock its owner out.
 */
import type { HengeChannel, HengeV1 } from '@swarm-explorer/schema';
import type { ChannelPerm, PermSet } from '../community-schema';

export const CHANNEL_PERMS: readonly ChannelPerm[] = ['view', 'send', 'start_threads', 'mention_everyone', 'add_reactions', 'manage_messages', 'post_via_api'];
export const BUILTIN_ROLES = ['owner', 'maintainer', 'mod', 'member', 'agent', 'observer'] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];
export type FullPerms = Record<ChannelPerm, boolean>;

/** Fallback when the file gives no `community.defaults.mentions_everyone` (the example file's own list). */
export const DEFAULT_MENTION_EVERYONE_ROLES = ['owner', 'maintainer', 'mod'];
const STAFF = new Set(['owner', 'maintainer', 'mod']);

export const NO_PERMS: FullPerms = Object.fromEntries(CHANNEL_PERMS.map((p) => [p, false])) as FullPerms;
export const ALL_PERMS: FullPerms = Object.fromEntries(CHANNEL_PERMS.map((p) => [p, true])) as FullPerms;

/**
 * Henge-wide capabilities. `moderate` in a role's `can` list implies the moderation set; `edit_any`
 * implies everything. The file's `remove` maps to `kick`.
 */
export const CAPABILITIES = [
  'moderate', 'pin', 'slow_mode', 'timeout', 'kick', 'ban', 'read_audit_log', 'review_reports', 'revoke_agent_tokens',
  'manage_channels', 'manage_roles', 'bulk_delete',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
const MODERATE_IMPLIES: ReadonlySet<string> = new Set(['pin', 'slow_mode', 'timeout', 'kick', 'ban', 'read_audit_log', 'review_reports', 'revoke_agent_tokens', 'bulk_delete']);

/** Channel defaults for a role from its `can` list in `governance.roles`. */
export function roleDefaultPerms(role: string, can: readonly string[], mentionEveryoneRoles: readonly string[]): FullPerms {
  if (role === 'owner') return { ...ALL_PERMS };
  if (role === 'observer') return { ...NO_PERMS, view: true };
  const staff = STAFF.has(role);
  const has = (c: string) => can.includes(c);
  return {
    view: true,
    send: staff || has('chat') || has('chat_via_api'),
    start_threads: staff || has('start_threads'),
    mention_everyone: mentionEveryoneRoles.includes(role),
    add_reactions: staff || has('react'),
    manage_messages: has('moderate') || has('edit_any'),
    post_via_api: staff || has('chat_via_api'),
  };
}

export function roleCapabilities(role: string, can: readonly string[]): string[] {
  const out = new Set<string>(can);
  if (can.includes('remove')) out.add('kick');
  if (role === 'owner') out.add('manage_roles');
  return [...out].sort();
}

export type RoleSeed = { key: string; name: string; builtin: boolean; position: number; perms: FullPerms; capabilities: string[] };

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** The six built-in roles plus any other role the file declares, in file order. */
export function rolesFromHenge(h: HengeV1): RoleSeed[] {
  const mention = h.community?.defaults?.mentions_everyone ?? DEFAULT_MENTION_EVERYONE_ROLES;
  const keys = [...BUILTIN_ROLES, ...Object.keys(h.governance.roles).filter((k) => !(BUILTIN_ROLES as readonly string[]).includes(k))];
  return keys.map((key, position) => {
    const can = h.governance.roles[key]?.can ?? [];
    return { key, name: titleCase(key), builtin: (BUILTIN_ROLES as readonly string[]).includes(key), position, perms: roleDefaultPerms(key, can, mention), capabilities: roleCapabilities(key, can) };
  });
}

/**
 * Channel overrides from one channel entry in the file:
 * - `post: [roles]` gives `send` (and, for agents, `post_via_api`) to exactly those roles.
 *   Announcement channels without a list post as owner, maintainer and mod; agent_run channels as agents.
 * - `read: [roles]` gives `view` to exactly those roles and makes the channel non-public.
 * Everything else inherits the role defaults, so non-posters can still react and thread.
 */
export function channelSeed(ch: HengeChannel, roleKeys: readonly string[]): { public: boolean; overrides: Record<string, PermSet> } {
  const post = ch.post ?? (ch.type === 'announcement' ? ['owner', 'maintainer', 'mod'] : ch.type === 'agent_run' ? ['agent'] : undefined);
  const overrides: Record<string, PermSet> = {};
  const set = (role: string, p: PermSet) => (overrides[role] = { ...overrides[role], ...p });
  for (const role of roleKeys) {
    if (role === 'owner') continue;
    if (post) {
      const may = post.includes(role);
      set(role, { send: may, post_via_api: may && role !== 'observer' });
    }
    if (ch.read) set(role, { view: ch.read.includes(role) });
  }
  return { public: !ch.read, overrides };
}

export type ChannelFacts = { public: boolean; archived: boolean };

/** Union over the actor's roles of (role default, then channel override). Observers see public channels only. */
export function effectivePerms(
  roles: readonly string[],
  roleDefaults: ReadonlyMap<string, PermSet>,
  overrides: ReadonlyMap<string, PermSet>,
  channel: ChannelFacts,
): FullPerms {
  let out: FullPerms;
  if (roles.includes('owner')) out = { ...ALL_PERMS };
  else {
    out = { ...NO_PERMS };
    for (const role of roles) {
      const eff: FullPerms = { ...NO_PERMS, ...stripNulls(roleDefaults.get(role)), ...stripNulls(overrides.get(role)) };
      if (role === 'observer' && !channel.public) continue;
      if (!eff.view) continue;
      for (const p of CHANNEL_PERMS) out[p] = out[p] || eff[p];
    }
    if (!out.view) return { ...NO_PERMS };
  }
  if (channel.archived) return { ...out, send: false, start_threads: false, add_reactions: false, post_via_api: false };
  return out;
}

function stripNulls(p: PermSet | undefined): PermSet {
  const out: PermSet = {};
  if (!p) return out;
  for (const k of CHANNEL_PERMS) if (typeof p[k] === 'boolean') out[k] = p[k];
  return out;
}

export function hasCapability(roles: readonly string[], roleCaps: ReadonlyMap<string, readonly string[]>, cap: Capability): boolean {
  if (roles.includes('owner')) return true;
  for (const role of roles) {
    const can = roleCaps.get(role) ?? [];
    if (can.includes(cap) || can.includes('edit_any')) return true;
    if (can.includes('moderate') && MODERATE_IMPLIES.has(cap)) return true;
  }
  return false;
}

/** Who may act on whom: an actor moderates only actors of strictly lower rank. The owner outranks all. */
export function rank(roles: readonly string[]): number {
  const r = (k: string) => ({ owner: 100, maintainer: 80, mod: 60, member: 20, agent: 10, observer: 0 })[k] ?? 30;
  return roles.reduce((m, k) => Math.max(m, r(k)), 0);
}
/** The Moderation Glyph acts with mod rank: it never touches mods, maintainers or the owner. */
export const GLYPH_RANK = 60;

/** Can this actor post a message (top level or in a thread) in this channel? */
export type PostDecision = { ok: true } | { ok: false; code: string; message: string };

export function canPost(p: {
  actorType: 'human' | 'agent';
  perms: FullPerms;
  channelType: 'text' | 'announcement' | 'agent_run';
  agentsPolicy: string | null;
  thread: null | { starting: boolean };
}): PostDecision {
  const { perms } = p;
  // Agents post through the API: the agent role needs send or post via API (spec 8.2).
  const base = p.actorType === 'agent' ? perms.send || perms.post_via_api : perms.send;
  if (!p.thread) {
    if (!base) return { ok: false, code: 'cannot_send', message: 'Your role cannot post in this channel.' };
    if (p.actorType === 'agent' && p.agentsPolicy === 'reply_in_threads_only') {
      return { ok: false, code: 'agents_reply_in_threads_only', message: 'Agents reply in threads here; they do not post to the channel.' };
    }
    return { ok: true };
  }
  if (p.thread.starting && !perms.start_threads) return { ok: false, code: 'cannot_start_threads', message: 'Your role cannot start threads in this channel.' };
  // In announcement and agent_run channels, roles that cannot post may still reply in threads.
  const threadOk = base || (p.channelType !== 'text' && perms.start_threads && p.actorType === 'human');
  if (!threadOk) return { ok: false, code: 'cannot_send', message: 'Your role cannot post in this channel.' };
  return { ok: true };
}
