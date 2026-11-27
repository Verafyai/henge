import { sign } from 'node:crypto';
import {
  ApiError,
  createAgentCommunityClient,
  createCommunityClient,
  newIdempotencyKey,
  type CommunityClient,
  type CommunityEvent,
} from '@swarm-explorer/api-client';
import { accounts, getDb } from '@swarm-explorer/db';
import { exampleHengeSource, runMigrations, seed } from '@swarm-explorer/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { communityRoute } from '@/lib/community/router';
import { signIn, type Device } from '@/lib/test-device';
import { GET as henges } from './henges/[[...path]]/route';

/** Calls the community router in process, so the typed client and its contracts are exercised end to end. */
const inProcess: typeof fetch = async (input, init) => {
  const req = new Request(input as string, init);
  const path = new URL(req.url).pathname.replace(/^\/v1/, '');
  return communityRoute(req, path);
};
const BASE = 'http://localhost';
const client = (d: Device) => createCommunityClient({ baseUrl: BASE, getAccessToken: () => d.token, fetch: inProcess });
const agentClient = (d: Device, token: string) =>
  createAgentCommunityClient({ baseUrl: BASE, token, fetch: inProcess, sign: (m) => sign(null, Buffer.from(m), d.privateKey).toString('base64url') });

async function err(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
}

async function person(handle: string, profile = handle.replace(/-/g, '_')) {
  const db = await getDb();
  await db.insert(accounts).values({ handle, displayName: handle, createdAt: new Date(Date.now() - 30 * 86_400_000) }).onConflictDoNothing();
  const d = await signIn(handle);
  const c = client(d);
  await c.saveProfile({ handle: profile, display_name: handle });
  return { d, c };
}

let owner: { d: Device; c: CommunityClient };
let mod: { d: Device; c: CommunityClient };
let maria: { d: Device; c: CommunityClient };
let lee: { d: Device; c: CommunityClient };
let hengeId = '';
let ch: Record<string, string> = {};
const subs: { close: () => void }[] = [];

beforeAll(async () => {
  await runMigrations();
  await seed();
  owner = await person('example-owner');
  mod = await person('example-mod-1');
  maria = await person('maria');
  lee = await person('lee');
  const r = await owner.c.createOrJoin(exampleHengeSource(), 'https://github.com/example-org/resolved-forecasts');
  hengeId = r.henge.id;
  for (const p of [mod, maria, lee]) await p.c.join(hengeId);
  const list = await owner.c.listChannels(hengeId);
  ch = Object.fromEntries(list.channels.map((c) => [c.key, c.id]));
}, 120_000);

afterAll(() => subs.forEach((s) => s.close()));

describe('profiles and handles', () => {
  it('needs a profile first, checks handles, and serves public profiles', async () => {
    const db = await getDb();
    await db.insert(accounts).values({ handle: 'newcomer', displayName: 'n' });
    const c = client(await signIn('newcomer'));
    expect(await err(c.myProfile())).toMatchObject({ status: 404, code: 'profile_not_set' });
    expect(await err(c.join(hengeId))).toMatchObject({ status: 409, code: 'profile_required' });
    expect(await c.handleAvailable('admin')).toMatchObject({ available: false, reason: 'reserved' });
    expect(await c.handleAvailable('MARIA')).toMatchObject({ available: false, reason: 'taken' });
    expect(await c.handleAvailable('mаria')).toMatchObject({ available: false, reason: 'confusable' });
    expect(await err(c.saveProfile({ handle: 'everyone', display_name: 'x' }))).toMatchObject({ status: 400, code: 'handle_reserved' });
    expect(await err(c.saveProfile({ handle: 'newcomer', display_name: 'x'.repeat(33) }))).toMatchObject({ status: 400, code: 'display_name_invalid' });
    const p = await c.saveProfile({ handle: 'Newcomer', display_name: 'New Comer', bio: 'hi' });
    expect(p).toMatchObject({ handle: 'newcomer', display_name: 'New Comer', bio: 'hi', avatar_url: null });
    expect(await c.profile('NEWCOMER')).toMatchObject({ handle: 'newcomer', agents: [] });
  });

  it('re-encodes avatars to a 256 px square WebP with no metadata', async () => {
    const jpeg = await sharp({ create: { width: 640, height: 400, channels: 3, background: { r: 200, g: 30, b: 40 } } })
      .withExif({ IFD0: { Copyright: 'secret-owner', ImageDescription: 'gps-here' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const r = await maria.c.uploadAvatar(new Uint8Array(jpeg), 'image/jpeg');
    expect(r.avatar_url).toMatch(/^\/v1\/avatars\/[0-9a-f-]{36}\?v=/);
    const res = await communityRoute(new Request(`${BASE}${r.avatar_url}`), r.avatar_url!.split('?')[0]!.replace('/v1', ''));
    expect(res.headers.get('content-type')).toBe('image/webp');
    const out = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });
    expect(meta.exif).toBeUndefined();
    expect(out.includes(Buffer.from('secret-owner'))).toBe(false);
    // Type checks: the declared type must match the bytes; GIF and oversize files are refused.
    expect(await err(maria.c.uploadAvatar(new Uint8Array(jpeg), 'image/png'))).toMatchObject({ status: 400, code: 'avatar_type_mismatch' });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]);
    expect(await err(maria.c.uploadAvatar(gif, 'image/png'))).toMatchObject({ status: 400, code: 'avatar_type' });
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await err(maria.c.uploadAvatar(big, 'image/png'))).toMatchObject({ status: 413 });
    // A crop outside the image is refused; one inside works.
    expect(await err(maria.c.uploadAvatar(new Uint8Array(jpeg), 'image/jpeg', { x: 500, y: 0, size: 300 }))).toMatchObject({ code: 'avatar_crop_invalid' });
    await maria.c.uploadAvatar(new Uint8Array(jpeg), 'image/jpeg', { x: 100, y: 50, size: 300 });
  });
});

describe('Henges, channels and messages over HTTP', () => {
  it('routes through the Next route file and refuses anonymous callers', async () => {
    const res = await henges(new Request(`${BASE}/v1/henges`), { params: Promise.resolve({ path: undefined }) } as never);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const page = await henges(new Request(`${BASE}/v1/henges/${hengeId}`, { headers: { authorization: `Bearer ${lee.d.token}` } }), { params: Promise.resolve({ path: [hengeId] }) } as never);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toContain('no-store');
  });

  it('creating needs an owner listed in the file; joining checks the pinned digest', async () => {
    expect(await err(lee.c.createOrJoin(exampleHengeSource({ id: 'example-org/another' })))).toMatchObject({ status: 403, code: 'not_an_owner' });
    const again = await lee.c.createOrJoin(exampleHengeSource());
    expect(again).toMatchObject({ created: false, henge: { id: hengeId } });
    expect(await err(lee.c.createOrJoin(exampleHengeSource().replace('Resolved Forecasts (example)', 'Changed')))).toMatchObject({ status: 409, code: 'henge_digest_mismatch' });
    expect(await err(lee.c.createOrJoin('henge: "1.0"\nkind: swarm\n'))).toMatchObject({ status: 422, code: 'henge_invalid' });
    expect((await lee.c.myHenges()).items.map((i) => i.henge.id)).toEqual([hengeId]);
  });

  it('seeds categories and channels from the community block', async () => {
    const list = await lee.c.listChannels(hengeId);
    expect(list.categories.map((c) => c.key)).toEqual(['info', 'community', 'work']);
    expect(list.channels.map((c) => c.key)).toEqual(['welcome', 'rules', 'announcements', 'general', 'introductions', 'tasks', 'results', 'strategy-lab', 'proposals']);
    const general = list.channels.find((c) => c.key === 'general')!;
    expect(general).toMatchObject({ slow_mode_s: 10, agents_policy: 'reply_in_threads_only', my_perms: { send: true, mention_everyone: false } });
    expect(list.channels.find((c) => c.key === 'welcome')!.my_perms).toMatchObject({ send: false, add_reactions: true, start_threads: true });
    const me = await mod.c.getHenge(hengeId);
    expect(me.me.roles.sort()).toEqual(['member', 'mod']);
    expect(me.me.capabilities).toEqual(expect.arrayContaining(['timeout', 'ban', 'read_audit_log', 'review_reports']));
    expect(me.report_reasons).toEqual(['spam', 'harassment', 'off_topic', 'leaked_answer', 'other']);
  });

  it('posts, replies, threads, edits, reacts, pins and paginates', async () => {
    const a = await maria.c.postMessage(hengeId, ch.introductions!, { body: 'Welcome to the new members this week.' });
    const b = await lee.c.postMessage(hengeId, ch.introductions!, { body: 'Thanks!', reply_to: a.id });
    expect(b.reply_to).toMatchObject({ id: a.id, author: { handle: 'maria' }, excerpt: 'Welcome to the new members this week.' });
    const t = await lee.c.postMessage(hengeId, ch.introductions!, { body: 'in thread', thread_root: a.id });
    const thread = await maria.c.getThread(hengeId, a.id);
    expect(thread.root.thread).toMatchObject({ reply_count: 1 });
    expect(thread.items.map((i) => i.id)).toEqual([t.id]);
    const e = await maria.c.editMessage(hengeId, a.id, 'Welcome, everyone.');
    expect(e.edited_at).not.toBeNull();
    await lee.c.addReaction(hengeId, a.id, '👋');
    await lee.c.addReaction(hengeId, a.id, '👋');
    const r = await mod.c.addReaction(hengeId, a.id, '👋');
    expect(r.count).toBe(2);
    expect(await err(lee.c.addReaction(hengeId, a.id, ':wave:'))).toMatchObject({ status: 400, code: 'emoji_invalid' });
    expect(await err(lee.c.pin(hengeId, a.id))).toMatchObject({ status: 403, code: 'cannot_pin' });
    await mod.c.pin(hengeId, a.id);
    expect((await lee.c.listPins(hengeId, ch.introductions!)).items[0]).toMatchObject({ message: { id: a.id }, pinned_by: { handle: 'example_mod_1' } });
    for (let i = 0; i < 4; i++) await maria.c.postMessage(hengeId, ch['strategy-lab']!, { body: `page ${i}` });
    const p1 = await lee.c.listMessages(hengeId, ch['strategy-lab']!, { limit: 3 });
    expect(p1.items.map((m) => m.body)).toEqual(['page 1', 'page 2', 'page 3']);
    const p2 = await lee.c.listMessages(hengeId, ch['strategy-lab']!, { before: p1.next_before!, limit: 3 });
    expect(p2.items.map((m) => m.body)).toEqual(['page 0']);
    expect(p2.next_before).toBeNull();
    const page = await lee.c.listMessages(hengeId, ch.introductions!);
    expect(page.items.find((m) => m.id === a.id)).toMatchObject({ reactions: [{ emoji: '👋', count: 2, me: true }], pinned: true, thread: { reply_count: 1 } });
  });

  it('writes need an Idempotency-Key and replay with the same key', async () => {
    const path = `${BASE}/v1/henges/${hengeId}/channels/${ch['strategy-lab']}/messages`;
    const send = (key?: string) =>
      inProcess(path, { method: 'POST', headers: { authorization: `Bearer ${lee.d.token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ body: 'once' }) });
    expect((await send()).status).toBe(400);
    const key = newIdempotencyKey();
    const one = (await (await send(key)).json()) as { id: string };
    const two = await send(key);
    expect(two.headers.get('idempotent-replay')).toBe('true');
    expect(((await two.json()) as { id: string }).id).toBe(one.id);
  });

  it('slow mode and rate limits answer 429 with Retry-After', async () => {
    await lee.c.postMessage(hengeId, ch.general!, { body: 'first' });
    const res = await inProcess(`${BASE}/v1/henges/${hengeId}/channels/${ch.general}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lee.d.token}`, 'content-type': 'application/json', 'idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({ body: 'second' }),
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('slow_mode');
    // Moderators are not slowed.
    await mod.c.postMessage(hengeId, ch.general!, { body: 'a' });
    await mod.c.postMessage(hengeId, ch.general!, { body: 'b' });
    // 20 a minute for people (the file's human_messages_per_minute).
    const errs: ApiError[] = [];
    for (let i = 0; i < 25; i++) await maria.c.postMessage(hengeId, ch.results!, { body: `r${i}` }).catch((e: ApiError) => errs.push(e));
    // #results is agent_run: people cannot post there at all.
    expect(errs[0]).toMatchObject({ status: 403 });
    const limited: ApiError[] = [];
    for (let i = 0; i < 22; i++) await maria.c.postMessage(hengeId, ch['strategy-lab']!, { body: `burst ${i}` }).catch((e: ApiError) => limited.push(e));
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]).toMatchObject({ status: 429, code: 'rate_limited' });
    expect((limited[0]!.details as { retry_after_s: number }).retry_after_s).toBeGreaterThanOrEqual(1);
  });

  it('unread counts and read markers', async () => {
    const m = await lee.c.postMessage(hengeId, ch.introductions!, { body: '@maria are you there?' });
    const u = await maria.c.unread(hengeId);
    const intro = u.channels.find((c) => c.channel_id === ch.introductions)!;
    expect(intro.mentions).toBeGreaterThanOrEqual(1);
    await maria.c.markRead(hengeId, ch.introductions!, m.id);
    expect((await maria.c.unread(hengeId)).channels.find((c) => c.channel_id === ch.introductions)).toMatchObject({ unread: 0, mentions: 0 });
  });
});

describe('agents over HTTP (spec 8.2, 8.3)', () => {
  let token = '';
  let agentId = '';

  it('binds an agent to the signed-in device and issues a per-Henge token once', async () => {
    // Creating an agent proves the device key: an unsigned request is refused.
    const unsigned = await inProcess(`${BASE}/v1/me/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${maria.d.token}`, 'content-type': 'application/json', 'idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({ handle: 'grok_node', display_name: 'grok-node' }),
    });
    expect(unsigned.status).toBe(401);
    const { signed } = await import('@/lib/test-device');
    const body = JSON.stringify({ handle: 'grok_node', display_name: 'grok-node' });
    const res = await communityRoute(signed(maria.d, 'POST', '/v1/me/agents', body), '/me/agents');
    expect(res.status).toBe(201);
    agentId = ((await res.json()) as { id: string }).id;
    const t = await maria.c.addAgent(hengeId, agentId);
    token = t.token;
    expect(token).toMatch(/^sxg_/);
    expect((await maria.c.myProfile()).agents.map((a) => a.handle)).toEqual(['grok_node']);
  });

  it('posts only where the agent role may; 403 and an audit entry elsewhere', async () => {
    const a = agentClient(maria.d, token);
    const posted = await a.postMessage(hengeId, ch.tasks!, { body: '@lee your qualification set finished.' });
    expect(posted.author).toMatchObject({ type: 'agent', handle: 'grok_node', owner: { handle: 'maria' } });
    expect(await err(a.postMessage(hengeId, ch.announcements!, { body: 'x' }))).toMatchObject({ status: 403, code: 'cannot_send' });
    expect(await err(a.postMessage(hengeId, ch.general!, { body: 'x' }))).toMatchObject({ status: 403, code: 'agents_reply_in_threads_only' });
    const log = await owner.c.auditLog(hengeId, { action: 'agent.post_refused' });
    expect(log.items.slice(0, 2).map((i) => i.reason)).toEqual(['agents_reply_in_threads_only', 'cannot_send']);
    expect(log.items[0]!.actor).toMatchObject({ type: 'agent', handle: 'grok_node' });
  });

  it('agent tokens are scoped: device signature required, Henge-bound, limited endpoints, revocable', async () => {
    const path = `${BASE}/v1/henges/${hengeId}/channels/${ch.tasks}/messages`;
    const noSig = await inProcess(path, { headers: { authorization: `Bearer ${token}` } });
    expect(noSig.status).toBe(401);
    const wrongKey = agentClient(lee.d, token);
    expect(await err(wrongKey.listMessages(hengeId, ch.tasks!))).toMatchObject({ status: 401, code: 'device_signature_invalid' });
    const a = agentClient(maria.d, token);
    expect(await err(a.call((await import('@swarm-explorer/api-client')).reportListSchema, 'GET', `/henges/${hengeId}/reports`))).toMatchObject({ status: 403, code: 'agent_scope' });
    expect((await a.listMessages(hengeId, ch.tasks!)).items.length).toBeGreaterThan(0);
    // 6 a minute per channel for agents (the file's agent_messages_per_minute); one was used above.
    const errs: ApiError[] = [];
    for (let i = 0; i < 6; i++) await a.postMessage(hengeId, ch.results!, { body: `result ${i}` }).catch((e: ApiError) => errs.push(e));
    expect(errs).toHaveLength(0);
    expect(await err(a.postMessage(hengeId, ch.results!, { body: 'one too many' }))).toMatchObject({ status: 429, code: 'rate_limited' });
    // A mod revokes the token (mockup 17); it stops working at once and the revocation is logged.
    await mod.c.revokeAgentToken(hengeId, agentId, 'spam');
    expect(await err(a.listMessages(hengeId, ch.tasks!))).toMatchObject({ status: 401, code: 'agent_token_invalid' });
    expect((await owner.c.auditLog(hengeId, { action: 'agent.token_revoked' })).items[0]).toMatchObject({ reason: 'spam', actor: { handle: 'example_mod_1' } });
    // The owner rotates a fresh one.
    const fresh = await maria.c.rotateAgentToken(hengeId, agentId);
    expect((await agentClient(maria.d, fresh.token).listChannels(hengeId)).channels.length).toBeGreaterThan(0);
    token = fresh.token;
  });

  it('a ban covers the account and every agent it runs', async () => {
    const victim = await person('spam-owner');
    await victim.c.join(hengeId);
    const { signed } = await import('@/lib/test-device');
    const res = await communityRoute(signed(victim.d, 'POST', '/v1/me/agents', JSON.stringify({ handle: 'spam_node_77', display_name: 'spam-node-77' })), '/me/agents');
    const id = ((await res.json()) as { id: string }).id;
    const t = await victim.c.addAgent(hengeId, id);
    const a = agentClient(victim.d, t.token);
    await a.postMessage(hengeId, ch.tasks!, { body: 'Free credits at this link...' });
    expect(await err(lee.c.ban(hengeId, victim.d.installId, 'x'))).toMatchObject({ status: 403 });
    const me = await victim.c.getHenge(hengeId);
    await mod.c.ban(hengeId, me.me.actor_id, 'harassment after a warning');
    expect(await err(victim.c.getHenge(hengeId))).toMatchObject({ status: 403, code: 'banned' });
    expect(await err(a.listMessages(hengeId, ch.tasks!))).toMatchObject({ status: 401 });
    expect((await mod.c.bans(hengeId)).items[0]).toMatchObject({ reason: 'harassment after a warning', actor: { handle: 'spam_owner' } });
    expect(await victim.c.appeal(hengeId, 'I was hacked.')).toMatchObject({ status: 'open' });
    const queue = await mod.c.reports(hengeId);
    const appeal = queue.items.find((r) => r.kind === 'appeal')!;
    await mod.c.resolveReport(hengeId, appeal.id, { outcome: 'deny_appeal' });
    expect((await victim.c.myReports(hengeId).catch((e: ApiError) => e)) as ApiError).toMatchObject({ code: 'banned' });
  });
});

describe('moderation over HTTP', () => {
  it('reports queue with snapshots, private outcomes and the Glyph auto-timeout', async () => {
    const troll = await person('troll-example');
    await troll.c.join(hengeId);
    const m = await troll.c.postMessage(hengeId, ch.introductions!, { body: 'Free credits at this link' });
    const reporters = [maria, lee, owner];
    for (const r of reporters) await r.c.report(hengeId, { message_id: m.id, reason: 'spam' });
    const queue = await mod.c.reports(hengeId);
    const mine = queue.items.filter((r) => r.message_id === m.id);
    expect(mine).toHaveLength(3);
    expect(mine[0]).toMatchObject({ reason: 'spam', reports_on_message: 3, target: { handle: 'troll_example' }, snapshot: { message: { body: 'Free credits at this link' } } });
    expect(await err(troll.c.postMessage(hengeId, ch.introductions!, { body: 'more' }))).toMatchObject({ status: 403, code: 'timed_out' });
    const glyph = await owner.c.auditLog(hengeId, { actor: 'verafy/moderation' });
    expect(glyph.items[0]).toMatchObject({ action: 'member.timed_out', actor: { display_name: 'Moderation Glyph' }, target: { handle: 'troll_example' } });
    await mod.c.resolveReport(hengeId, mine[0]!.id, { outcome: 'delete', note: 'Link spam.' });
    const outcome = (await maria.c.myReports(hengeId)).items.find((r) => r.message_id === m.id)!;
    expect(outcome).toMatchObject({ status: 'actioned', outcome: 'delete' });
    expect(outcome.outcome_note).toContain('A moderator removed the message.');
    expect(await err(lee.c.reports(hengeId))).toMatchObject({ status: 403 });
  });

  it('timeouts, kicks, slow mode and bulk delete are mod-only and logged', async () => {
    const noisy = await person('noisy-example');
    await noisy.c.join(hengeId);
    for (let i = 0; i < 3; i++) await noisy.c.postMessage(hengeId, ch['strategy-lab']!, { body: `x${i}` });
    const id = (await noisy.c.getHenge(hengeId)).me.actor_id;
    expect(await err(lee.c.timeout(hengeId, id, '5m', 'x'))).toMatchObject({ status: 403 });
    expect(await err(mod.c.timeout(hengeId, id, '2h' as never, 'x'))).toMatchObject({ status: 400 });
    await mod.c.timeout(hengeId, id, '5m', 'cool down');
    await mod.c.clearTimeout(hengeId, id);
    expect(await mod.c.bulkDelete(hengeId, id, 60, 'spam')).toEqual({ deleted: 3 });
    await mod.c.kick(hengeId, id, 'spam');
    expect(await err(noisy.c.getHenge(hengeId))).toMatchObject({ code: 'not_a_member' });
    expect(await err(lee.c.updateChannel(hengeId, ch.general!, { slow_mode_s: 30 }))).toMatchObject({ status: 403 });
    await mod.c.updateChannel(hengeId, ch.general!, { slow_mode_s: 10 });
    await mod.c.updateChannel(hengeId, ch.general!, { slow_mode_s: 15 });
    expect(await err(mod.c.updateChannel(hengeId, ch.general!, { name: 'renamed' }))).toMatchObject({ status: 403 });
    const log = await owner.c.auditLog(hengeId);
    expect(log.items.map((i) => i.action)).toEqual(expect.arrayContaining(['member.timed_out', 'member.timeout_cleared', 'messages.bulk_deleted', 'member.kicked', 'channel.slow_mode']));
    expect(log.items.find((i) => i.action === 'channel.slow_mode')!.payload).toMatchObject({ from_s: 10, to_s: 15 });
    expect(await err(lee.c.auditLog(hengeId))).toMatchObject({ status: 403 });
  });

  it('channel CRUD, roles and the permission matrix are owner tools', async () => {
    const c = await owner.c.createChannel(hengeId, { name: 'Office Hours', type: 'text' });
    expect(c.key).toBe('office-hours');
    expect(await err(lee.c.createChannel(hengeId, { name: 'x' }))).toMatchObject({ status: 403 });
    await owner.c.createRole(hengeId, { key: 'helper', name: 'Helper', capabilities: ['pin'] });
    const leeId = (await lee.c.getHenge(hengeId)).me.actor_id;
    await owner.c.setMemberRoles(hengeId, leeId, ['member', 'helper']);
    expect(await err(mod.c.setMemberRoles(hengeId, leeId, ['member', 'mod']))).toMatchObject({ status: 403 });
    expect((await lee.c.getHenge(hengeId)).me.capabilities).toContain('pin');
    const matrix = await owner.c.setPermissions(hengeId, c.id, { member: { send: false } });
    expect(matrix.roles.find((r) => r.key === 'member')).toMatchObject({ effective: { send: false }, overrides: { send: false } });
    expect(matrix.roles.find((r) => r.key === 'helper')!.effective.send).toBe(true);
    await owner.c.archiveChannel(hengeId, c.id);
    expect((await lee.c.listChannels(hengeId)).channels.some((x) => x.id === c.id)).toBe(false);
    expect((await owner.c.listChannels(hengeId, { archived: true })).channels.find((x) => x.id === c.id)).toMatchObject({ archived: true });
  });
});

describe('realtime over SSE', () => {
  it('delivers messages, edits, reactions and typing to another member, filtered per subscriber', async () => {
    const got: CommunityEvent[] = [];
    const sender = await person('rt-sender');
    await sender.c.join(hengeId);
    const observer = await person('quiet-observer');
    await observer.c.join(hengeId, { observer: true });
    const obsGot: CommunityEvent[] = [];
    let open = 0;
    subs.push(lee.c.events(hengeId, { onEvent: (e) => got.push(e), onOpen: () => open++ }));
    subs.push(observer.c.events(hengeId, { onEvent: (e) => obsGot.push(e), onOpen: () => open++ }));
    await expect.poll(() => open, { timeout: 5000 }).toBe(2);
    await new Promise((r) => setTimeout(r, 300));
    const waitFor = (pred: (e: CommunityEvent) => boolean) => expect.poll(() => got.some(pred), { timeout: 5000, interval: 20 }).toBe(true);

    const m = await sender.c.postMessage(hengeId, ch.introductions!, { body: 'realtime hello' });
    await waitFor((e) => e.kind === 'message.created' && (e.payload.message as { id: string }).id === m.id);
    await sender.c.editMessage(hengeId, m.id, 'realtime hello (edited)');
    await waitFor((e) => e.kind === 'message.updated' && (e.payload.message as { body: string }).body === 'realtime hello (edited)');
    await sender.c.addReaction(hengeId, m.id, '🔥');
    await waitFor((e) => e.kind === 'reaction.added' && e.payload.emoji === '🔥');
    await sender.c.typing(hengeId, ch.introductions!);
    await waitFor((e) => e.kind === 'typing' && (e.payload.actor as { handle: string }).handle === 'rt_sender');
    // A private channel event and someone else's read marker never reach the observer or lee.
    await sender.c.markRead(hengeId, ch.introductions!, m.id);
    await owner.c.postMessage(hengeId, ch.tasks!, { body: 'owner in tasks' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 800));
    expect(got.some((e) => e.kind === 'read.updated')).toBe(false);
    expect(obsGot.some((e) => e.channel_id === ch.tasks)).toBe(false);
    expect(obsGot.some((e) => e.kind === 'message.created' && (e.payload.message as { id: string }).id === m.id)).toBe(true);
    expect(got.some((e) => e.kind === 'audit.appended')).toBe(false);
    // Resume: a new subscription from an earlier id gets later events again, de-duplicated by id.
    const firstId = got.find((e) => e.kind === 'message.created')!.id;
    const replay: CommunityEvent[] = [];
    subs.push(lee.c.events(hengeId, { lastEventId: firstId, onEvent: (e) => replay.push(e) }));
    await expect.poll(() => replay.some((e) => e.kind === 'reaction.added'), { timeout: 5000 }).toBe(true);
    expect(replay.some((e) => e.id === firstId)).toBe(false);
    expect(new Set(replay.map((e) => e.id)).size).toBe(replay.length);
  });
});
