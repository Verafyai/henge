import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseGlyph, parseHenge } from '@swarm-explorer/schema';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, repoRoot } from '../client';
import { communityAuditLog, communityChannels, communityHandles, communityMessages, communityProfiles } from '../community-schema';
import { runMigrations, seed } from '../testing';
import { MODERATION_RUNE_DEFAULTS, moderationGlyph, rateLimits, SPEC_RATE_LIMIT_FALLBACKS } from './config';
import { access, CommunityError, type Access, type Actor } from './context';
import { checkHandle } from './handles';
import { addAgentToHenge, createOrJoinHenge, joinHenge, listChannels, permissionMatrix, setPermissionOverrides } from './henges';
import { addReaction, deleteMessage, editMessage, listMessages, postMessage, unreadCounts, markRead } from './messages';
import { banMember, bulkDelete, kickMember, readAuditLog, reportMessage, resolveReport, timeoutMember } from './moderation';
import { channelSeed, effectivePerms, rolesFromHenge, roleDefaultPerms } from './perms';
import { createAgent, deleteCommunityAccount, handleAvailability, upsertProfile } from './profiles';
import { takePerMinute } from './rate-limit';
import { purgeHenge } from './retention';
import { exampleHengeSource, makeHuman, makeInstall } from './test-fixtures';
import { ulid, ulidTime } from './ulid';

let owner: Actor;
let mod: Actor;
let maria: Actor;
let lee: Actor;
let hengeId = '';
let ch: Record<string, string> = {};
let agent: Actor;

const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CommunityError) return { status: e.status, code: e.code, details: e.details };
    throw e;
  }
  throw new Error('expected a CommunityError');
};
const acc = (a: Actor): Promise<Access> => access(a, hengeId);

beforeAll(async () => {
  await runMigrations();
  await seed();
  owner = await makeHuman('example-owner');
  mod = await makeHuman('example-mod-1');
  maria = await makeHuman('maria');
  lee = await makeHuman('lee');
  const r = await createOrJoinHenge(owner, { source: exampleHengeSource() });
  hengeId = r.henge.id;
  await joinHenge(mod, hengeId, {});
  await joinHenge(maria, hengeId, {});
  await joinHenge(lee, hengeId, {});
  const { channels } = await listChannels(await acc(owner));
  ch = Object.fromEntries(channels.map((c) => [c.key, c.id]));
  const inst = await makeInstall(maria.id);
  const a = await createAgent(maria.id, inst.id, { handle: 'maria-node'.replace('-', '_'), display_name: 'maria-node' });
  agent = { type: 'agent', id: a.id, accountId: maria.id, accountCreatedAt: maria.accountCreatedAt };
  await addAgentToHenge(await acc(maria), a.id);
}, 120_000);

describe('ULIDs', () => {
  it('sort in creation order within one millisecond and carry their time', () => {
    const t = Date.now();
    const ids = Array.from({ length: 50 }, () => ulid(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ulidTime(ids[0]!)).toBe(t);
  });
});

describe('handles (spec 8.2)', () => {
  it('refuses reserved, confusable, malformed and out-of-range handles', () => {
    for (const h of ['admin', 'everyone', 'here', 'system', 'governance', 'moderation', 'mod', 'henge', 'verafy', 'verafy_support', 'owner', 'agent']) {
      expect(checkHandle(h)).toMatchObject({ ok: false, reason: 'reserved' });
    }
    // Cyrillic "а" inside Latin letters.
    expect(checkHandle('mаria')).toMatchObject({ ok: false, reason: 'confusable' });
    expect(checkHandle('мария')).toMatchObject({ ok: false, reason: 'characters' });
    expect(checkHandle('ab')).toMatchObject({ ok: false, reason: 'length' });
    expect(checkHandle('a'.repeat(25))).toMatchObject({ ok: false, reason: 'length' });
    expect(checkHandle('lee-node')).toMatchObject({ ok: false, reason: 'characters' });
    expect(checkHandle('.lee')).toMatchObject({ ok: false, reason: 'format' });
    expect(checkHandle('le..e')).toMatchObject({ ok: false, reason: 'format' });
    // NFKC folds full-width letters to ASCII; case folds to lower.
    expect(checkHandle('Ｋａｉ')).toEqual({ ok: true, handle: 'kai', key: 'kai' });
    expect(checkHandle('Grok.Node_7')).toEqual({ ok: true, handle: 'grok.node_7', key: 'grok.node_7' });
  });

  it('holds under concurrent signups: exactly one of 25 parallel claims wins', async () => {
    const people = await Promise.all(Array.from({ length: 25 }, (_, i) => makeHuman(`racer-${i}`, { profile: false })));
    const results = await Promise.allSettled(people.map((p) => upsertProfile(p.id, { handle: 'SameName', display_name: 'Racer' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(losers.every((r) => r.reason instanceof CommunityError && r.reason.code === 'handle_taken')).toBe(true);
    const db = await getDb();
    expect(await db.select().from(communityHandles).where(eq(communityHandles.key, 'samename'))).toHaveLength(1);
  });

  it('shares one namespace between people and agents, case-insensitively', async () => {
    const kai = await makeHuman('kai-x', { profile: false });
    expect(await fail(upsertProfile(kai.id, { handle: 'Maria_Node', display_name: 'Kai' }))).toMatchObject({ status: 409, code: 'handle_taken' });
    const inst = await makeInstall(lee.id);
    expect(await fail(createAgent(lee.id, inst.id, { handle: 'MARIA', display_name: 'x' }))).toMatchObject({ status: 409, code: 'handle_taken' });
    expect(await handleAvailability('Maria')).toMatchObject({ available: false, reason: 'taken' });
    expect(await handleAvailability('mаria')).toMatchObject({ available: false, reason: 'confusable' });
  });

  it('changes once per 30 days and holds the old handle for 30 days', async () => {
    const p = await makeHuman('changer');
    const t0 = new Date();
    await upsertProfile(p.id, { handle: 'changer_two' }, t0);
    const again = await fail(upsertProfile(p.id, { handle: 'changer_three' }, new Date(t0.getTime() + 86_400_000)));
    expect(again).toMatchObject({ status: 409, code: 'handle_change_too_soon' });
    // Case-only change is not a change.
    await upsertProfile(p.id, { handle: 'Changer_Two' }, new Date(t0.getTime() + 86_400_000));
    const other = await makeHuman('squatter', { profile: false });
    expect(await fail(upsertProfile(other.id, { handle: 'changer', display_name: 'S' }, new Date(t0.getTime() + 29 * 86_400_000)))).toMatchObject({ code: 'handle_taken' });
    await upsertProfile(other.id, { handle: 'changer', display_name: 'S' }, new Date(t0.getTime() + 31 * 86_400_000));
  });
});

describe('roles and the permission matrix from the .henge file (mockup 16)', () => {
  it('derives the six roles and their #general defaults', async () => {
    const f = parseHenge(exampleHengeSource());
    if (!f.ok) throw new Error('fixture');
    const roles = rolesFromHenge(f.henge);
    expect(roles.map((r) => r.key)).toEqual(['owner', 'maintainer', 'mod', 'member', 'agent', 'observer']);
    const m = await permissionMatrix(await acc(owner), ch.general!);
    const row = (k: string) => m.roles.find((r) => r.key === k)!.effective;
    expect(row('owner')).toEqual({ view: true, send: true, start_threads: true, mention_everyone: true, add_reactions: true, manage_messages: true, post_via_api: true });
    expect(row('mod')).toMatchObject({ view: true, send: true, start_threads: true, mention_everyone: true, add_reactions: true, manage_messages: true });
    expect(row('member')).toMatchObject({ view: true, send: true, start_threads: true, mention_everyone: false, add_reactions: true, manage_messages: false, post_via_api: false });
    expect(row('agent')).toMatchObject({ view: true, send: true, start_threads: false, mention_everyone: false, add_reactions: false, manage_messages: false, post_via_api: true });
    expect(row('observer')).toMatchObject({ view: true, send: false, add_reactions: false });
  });

  it('announcement channels post as listed; others still react and thread', () => {
    const defaults = new Map([
      ['member', roleDefaultPerms('member', ['chat', 'react', 'start_threads'], [])],
      ['agent', roleDefaultPerms('agent', ['chat_via_api'], [])],
    ]);
    const seedA = channelSeed({ id: 'welcome', type: 'announcement', post: ['owner', 'maintainer'] }, ['owner', 'maintainer', 'member', 'agent']);
    const p = effectivePerms(['member'], defaults, new Map(Object.entries(seedA.overrides)), { public: true, archived: false });
    expect(p).toMatchObject({ view: true, send: false, add_reactions: true, start_threads: true });
    const a = effectivePerms(['agent'], defaults, new Map(Object.entries(seedA.overrides)), { public: true, archived: false });
    expect(a).toMatchObject({ send: false, post_via_api: false });
  });

  it('read lists hide channels; observers read public channels only; archive stops posting', () => {
    const defaults = new Map([
      ['member', roleDefaultPerms('member', ['chat'], [])],
      ['observer', roleDefaultPerms('observer', ['read'], [])],
    ]);
    const tasks = channelSeed({ id: 'tasks', type: 'agent_run', post: ['agent'], read: ['member', 'agent'] }, ['owner', 'member', 'agent', 'observer', 'mod']);
    expect(tasks.public).toBe(false);
    const ov = new Map(Object.entries(tasks.overrides));
    expect(effectivePerms(['observer'], defaults, ov, { public: false, archived: false }).view).toBe(false);
    expect(effectivePerms(['observer'], defaults, new Map(), { public: true, archived: false })).toMatchObject({ view: true, send: false });
    expect(effectivePerms(['observer'], defaults, new Map(), { public: false, archived: false }).view).toBe(false);
    expect(effectivePerms(['member'], defaults, new Map(), { public: true, archived: true })).toMatchObject({ view: true, send: false });
    expect(effectivePerms(['owner'], new Map(), ov, { public: false, archived: false }).view).toBe(true);
  });

  it('channel overrides beat Henge defaults and are audited', async () => {
    const o = await acc(owner);
    await setPermissionOverrides(o, ch.introductions!, { member: { add_reactions: false } });
    const m = await permissionMatrix(o, ch.introductions!);
    expect(m.roles.find((r) => r.key === 'member')!.effective.add_reactions).toBe(false);
    const msg = await postMessage(await acc(lee), ch.introductions!, { body: 'hello' });
    expect(await fail(addReaction(await acc(maria), msg.id, '👋'))).toMatchObject({ status: 403, code: 'cannot_react' });
    await setPermissionOverrides(o, ch.introductions!, { member: { add_reactions: null } });
    await addReaction(await acc(maria), msg.id, '👋');
    const log = await readAuditLog(o, { action: 'channel.permissions_changed' });
    expect(log.items).toHaveLength(2);
    // A member cannot read the matrix or change it.
    expect(await fail(permissionMatrix(await acc(lee), ch.general!))).toMatchObject({ status: 403 });
    expect(await fail(setPermissionOverrides(await acc(mod), ch.general!, { member: { send: false } }))).toMatchObject({ status: 403 });
  });

  it('observers join to read public channels only and cannot post', async () => {
    const obs = await makeHuman('watcher');
    await joinHenge(obs, hengeId, { asObserver: true });
    const { channels } = await listChannels(await acc(obs));
    expect(channels.map((c) => c.key)).not.toContain('tasks');
    expect(channels.map((c) => c.key)).toContain('general');
    expect(await fail(postMessage(await acc(obs), ch.general!, { body: 'hi' }))).toMatchObject({ status: 403, code: 'cannot_send' });
    expect(await fail(listMessages(await acc(obs), ch.tasks!, {}))).toMatchObject({ status: 404, code: 'channel_not_found' });
  });
});

describe('agents (spec 8.2 "How agents post", 8.3)', () => {
  it('post only where the agent role may; elsewhere 403 and an audit entry', async () => {
    const a = await acc(agent);
    const ok = await postMessage(a, ch.tasks!, { body: 'qualification set finished' });
    expect(ok.author).toMatchObject({ type: 'agent', handle: 'maria_node', owner: { handle: 'maria' } });
    expect(await fail(postMessage(a, ch.welcome!, { body: 'hi' }))).toMatchObject({ status: 403, code: 'cannot_send' });
    expect(await fail(postMessage(a, ch.general!, { body: 'hi' }))).toMatchObject({ status: 403, code: 'agents_reply_in_threads_only' });
    const root = await postMessage(await acc(lee), ch.general!, { body: 'Should agents start threads?' });
    expect(await fail(postMessage(a, ch.general!, { body: 'I can only reply', thread_root: root.id }))).toMatchObject({ status: 403, code: 'cannot_start_threads' });
    await postMessage(await acc(maria), ch.general!, { body: 'Agents reply only.', thread_root: root.id });
    const reply = await postMessage(a, ch.general!, { body: 'I can only reply where my role allows it.', thread_root: root.id });
    expect(reply.thread_root).toBe(root.id);
    const db = await getDb();
    const refused = await db.select().from(communityAuditLog).where(and(eq(communityAuditLog.action, 'agent.post_refused'), eq(communityAuditLog.actorId, agent.id)));
    expect(refused.map((r) => r.reason).sort()).toEqual(['agents_reply_in_threads_only', 'cannot_send', 'cannot_start_threads']);
  });
});

describe('messages, mentions, unread', () => {
  it('gates @everyone, resolves @handle and @role, and counts unread and mentions', async () => {
    const m1 = await postMessage(await acc(lee), ch.introductions!, { body: '@everyone hi @maria and @mod' });
    expect(m1.mentions).toEqual({ actor_ids: [maria.id], roles: ['mod'], everyone: false });
    const m2 = await postMessage(await acc(mod), ch.introductions!, { body: '@everyone welcome' });
    expect(m2.mentions.everyone).toBe(true);
    const u = await unreadCounts(await acc(maria));
    const intro = u.channels.find((c) => c.channel_id === ch.introductions)!;
    expect(intro.unread).toBeGreaterThanOrEqual(2);
    expect(intro.mentions).toBeGreaterThanOrEqual(2);
    await markRead(await acc(maria), ch.introductions!, { message_id: m2.id });
    const after = (await unreadCounts(await acc(maria))).channels.find((c) => c.channel_id === ch.introductions)!;
    expect(after).toMatchObject({ unread: 0, mentions: 0, last_read_message_id: m2.id });
  });

  it('edits mark edited; authors delete their own; others need manage messages; deleted user after account deletion', async () => {
    const m = await postMessage(await acc(lee), ch.introductions!, { body: 'typo' });
    expect(await fail(editMessage(await acc(maria), m.id, 'x'))).toMatchObject({ status: 403, code: 'not_your_message' });
    const e = await editMessage(await acc(lee), m.id, 'fixed');
    expect(e.body).toBe('fixed');
    expect(e.edited_at).not.toBeNull();
    expect(await fail(deleteMessage(await acc(maria), m.id, null))).toMatchObject({ status: 403, code: 'cannot_manage_messages' });
    await deleteMessage(await acc(mod), m.id, 'cleanup');
    const log = await readAuditLog(await acc(owner), { action: 'message.deleted' });
    expect(log.items[0]).toMatchObject({ reason: 'cleanup', actor: { handle: 'example_mod_1' } });

    const gone = await makeHuman('leaving');
    await joinHenge(gone, hengeId, {});
    const said = await postMessage(await acc(gone), ch.introductions!, { body: 'bye' });
    await deleteCommunityAccount(gone.id);
    const page = await listMessages(await acc(maria), ch.introductions!, {});
    expect(page.items.find((x) => x.id === said.id)).toMatchObject({ body: null, deleted: true, author: { type: 'deleted', display_name: 'deleted user' } });
    const db = await getDb();
    const [row] = await db.select().from(communityMessages).where(eq(communityMessages.id, said.id));
    expect(row).toMatchObject({ authorType: 'deleted', authorId: null, body: '' });
    const [p] = await db.select().from(communityProfiles).where(eq(communityProfiles.accountId, gone.id));
    expect(p!.deletedAt).not.toBeNull();
  });
});

describe('rate limits and slow mode', () => {
  it('reads limits from the file and falls back to the spec values', () => {
    const f = parseHenge(exampleHengeSource());
    if (!f.ok) throw new Error('fixture');
    expect(rateLimits(f.henge)).toEqual({ human_messages_per_minute: 20, agent_messages_per_minute: 6, reactions_per_minute: SPEC_RATE_LIMIT_FALLBACKS.reactions_per_minute, new_account_messages_per_minute: 5 });
    const g = parseHenge(exampleHengeSource().replace('human_messages_per_minute: 20', 'human_messages_per_minute: 7'));
    if (!g.ok) throw new Error('fixture');
    expect(rateLimits(g.henge).human_messages_per_minute).toBe(7);
  });

  it('token buckets refuse past capacity with a retry time', async () => {
    const t = new Date();
    for (let i = 0; i < 3; i++) expect(await takePerMinute('test:bucket', 3, t)).toEqual({ ok: true });
    const r = await takePerMinute('test:bucket', 3, t);
    expect(r).toEqual({ ok: false, retryAfterS: 20 });
    expect(await takePerMinute('test:bucket', 3, new Date(t.getTime() + 20_000))).toEqual({ ok: true });
  });

  it('slow mode limits members but not moderators; new accounts get the lower limit', async () => {
    const t = new Date(Date.now() + 3600_000);
    await postMessage(await acc(lee), ch.general!, { body: 'one' }, t);
    expect(await fail(postMessage(await acc(lee), ch.general!, { body: 'two' }, new Date(t.getTime() + 1000)))).toMatchObject({ status: 429, code: 'slow_mode', details: { retry_after_s: 9 } });
    await postMessage(await acc(mod), ch.general!, { body: 'one' }, t);
    await postMessage(await acc(mod), ch.general!, { body: 'two' }, t);
    const fresh = await makeHuman('fresh', { ageMs: 3600_000 });
    await joinHenge(fresh, hengeId, {});
    const a = await acc(fresh);
    for (let i = 0; i < 5; i++) await postMessage(a, ch['strategy-lab']!, { body: `m${i}` }, t);
    expect(await fail(postMessage(a, ch['strategy-lab']!, { body: 'm5' }, t))).toMatchObject({ status: 429, code: 'rate_limited' });
  });
});

describe('moderation and the audit log', () => {
  it('the audit log cannot be updated, deleted or truncated', async () => {
    const db = await getDb();
    const [row] = await db.select().from(communityAuditLog).limit(1);
    const refused = async (p: Promise<unknown>) => {
      const e = await p.then(() => null, (err: unknown) => err as { message: string; cause?: { message: string } });
      expect(e?.cause?.message ?? e?.message).toMatch(/community_audit_log is append-only/);
    };
    await refused(db.update(communityAuditLog).set({ reason: 'edited' }).where(eq(communityAuditLog.id, row!.id)));
    await refused(db.delete(communityAuditLog).where(eq(communityAuditLog.id, row!.id)));
    await refused(db.execute(sql`truncate community_audit_log`));
    await refused(db.execute(sql`update community_audit_log set action = 'x'`));
    expect((await db.select().from(communityAuditLog).where(eq(communityAuditLog.id, row!.id)))[0]).toEqual(row);
  });

  it('a ban covers the owner and every agent the account runs', async () => {
    const spammer = await makeHuman('spammer');
    await joinHenge(spammer, hengeId, {});
    const inst = await makeInstall(spammer.id);
    const a = await createAgent(spammer.id, inst.id, { handle: 'spam_node_77', display_name: 'spam-node-77' });
    await addAgentToHenge(await acc(spammer), a.id);
    const spamAgent: Actor = { type: 'agent', id: a.id, accountId: spammer.id, accountCreatedAt: spammer.accountCreatedAt };
    await postMessage(await acc(spamAgent), ch.tasks!, { body: 'Free credits at this link' });
    expect(await fail(banMember(await acc(lee), spammer.id, { reason: 'x' }))).toMatchObject({ status: 403 });
    const r = await banMember(await acc(mod), spammer.id, { reason: 'harassment after a warning' });
    expect(r.appeal_until).not.toBeNull();
    expect(await fail(access(spammer, hengeId))).toMatchObject({ status: 403, code: 'banned' });
    expect(await fail(access(spamAgent, hengeId))).toMatchObject({ status: 403, code: 'banned' });
    expect(await fail(joinHenge(spammer, hengeId, {}))).toMatchObject({ status: 403, code: 'banned' });
  });

  it('moderators cannot act on equal or higher rank; kicks, timeouts and bulk deletes are logged', async () => {
    expect(await fail(timeoutMember(await acc(mod), owner.id, { preset: '1h', reason: 'x' }))).toMatchObject({ code: 'outranked' });
    const t = await timeoutMember(await acc(mod), lee.id, { preset: '10m', reason: 'cool down' });
    expect(t.until).toBeTruthy();
    expect(await fail(postMessage(await acc(lee), ch.introductions!, { body: 'hi' }))).toMatchObject({ status: 403, code: 'timed_out' });
    const noisy = await makeHuman('noisy');
    await joinHenge(noisy, hengeId, {});
    for (let i = 0; i < 3; i++) await postMessage(await acc(noisy), ch['strategy-lab']!, { body: `spam ${i}` });
    expect(await bulkDelete(await acc(mod), noisy.id, { minutes: 60, reason: 'spam' })).toEqual({ deleted: 3 });
    await kickMember(await acc(mod), noisy.id, { reason: 'spam' });
    expect(await fail(access(noisy, hengeId))).toMatchObject({ code: 'not_a_member' });
    const actions = (await readAuditLog(await acc(owner), { limit: 200 })).items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['member.timed_out', 'messages.bulk_deleted', 'member.kicked', 'member.banned', 'henge.created']));
    expect(await fail(readAuditLog(await acc(maria), {}))).toMatchObject({ status: 403 });
  });

  it('the Moderation Glyph times out an author after its Rune count of reports, logged as the Glyph', async () => {
    const f = parseHenge(exampleHengeSource());
    if (!f.ok) throw new Error('fixture');
    expect(moderationGlyph(f.henge)).toEqual({ autoTimeout: { reports: 3, windowMinutes: 10, durationMinutes: 60 }, linkFilter: 'new_members_only' });
    const troll = await makeHuman('troll');
    await joinHenge(troll, hengeId, {});
    const msg = await postMessage(await acc(troll), ch.introductions!, { body: 'rude' });
    const reporters = [maria, mod, await makeHuman('reporter3')];
    await joinHenge(reporters[2]!, hengeId, {});
    const first = await reportMessage(await acc(reporters[0]!), { message_id: msg.id, reason: 'harassment' });
    expect(first.glyph_timeout).toBeNull();
    expect(await fail(reportMessage(await acc(reporters[0]!), { message_id: msg.id, reason: 'spam' }))).toMatchObject({ code: 'already_reported' });
    await reportMessage(await acc(reporters[1]!), { message_id: msg.id, reason: 'harassment' });
    const third = await reportMessage(await acc(reporters[2]!), { message_id: msg.id, reason: 'spam' });
    expect(third.glyph_timeout).not.toBeNull();
    const log = await readAuditLog(await acc(owner), { actor: 'verafy/moderation' });
    expect(log.items[0]).toMatchObject({ action: 'member.timed_out', actor: { type: 'glyph', display_name: 'Moderation Glyph' }, reason: 'Rune: 3 reports in 10 minutes. Timeout 1 hour.' });
    const resolved = await resolveReport(await acc(mod), first.report_id, { outcome: 'delete' });
    expect(resolved.resolved).toHaveLength(3);
  });

  it('the link filter holds links from accounts under 24 hours for review', async () => {
    const newbie = await makeHuman('newbie', { ageMs: 3600_000 });
    await joinHenge(newbie, hengeId, {});
    const m = await postMessage(await acc(newbie), ch.introductions!, { body: 'see https://example.com/free' });
    expect(m.held).toBe(true);
    expect((await listMessages(await acc(maria), ch.introductions!, {})).items.some((x) => x.id === m.id)).toBe(false);
    expect((await listMessages(await acc(mod), ch.introductions!, {})).items.some((x) => x.id === m.id)).toBe(true);
    const old = await postMessage(await acc(maria), ch.introductions!, { body: 'see https://example.com/docs' });
    expect(old.held).toBe(false);
  });

  it('built-in Moderation Glyph Rune defaults match the manifest', () => {
    const src = readFileSync(path.join(repoRoot(), 'packages/schema/fixtures/glyphs/verafy/moderation.glyph.yaml'), 'utf8');
    const g = parseGlyph(src);
    if (!g.ok) throw new Error('glyph fixture');
    const defaults = Object.fromEntries((g.glyph.runes ?? []).map((r) => [r.id, r.default]));
    expect(defaults).toEqual(MODERATION_RUNE_DEFAULTS);
  });
});

describe('retention', () => {
  it('drops messages past data_policy.retention_days and purges deleted bodies after 30 days', async () => {
    const db = await getDb();
    const old = new Date(Date.now() - 100 * 86_400_000);
    const m = await postMessage(await acc(owner), ch.welcome!, { body: 'old news' }, old);
    const d = await postMessage(await acc(owner), ch.welcome!, { body: 'regret' }, new Date(Date.now() - 40 * 86_400_000));
    await deleteMessage(await acc(owner), d.id, null, new Date(Date.now() - 35 * 86_400_000));
    const r = await purgeHenge(hengeId, 90);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(communityMessages).where(eq(communityMessages.id, m.id))).toHaveLength(0);
    const [p] = await db.select().from(communityMessages).where(eq(communityMessages.id, d.id));
    expect(p).toMatchObject({ body: '' });
    expect(p!.purgedAt).not.toBeNull();
    expect((await db.select().from(communityChannels).where(eq(communityChannels.hengeId, hengeId))).length).toBe(9);
  });
});
