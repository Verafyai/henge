import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { HengeV1 } from '@swarm-explorer/schema';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { CommunityEventView } from '../../shared/henge';
import { ApiCommunityStore } from './api';

const EXAMPLE = parse(readFileSync(path.resolve(__dirname, '../../../../../packages/schema/fixtures/henge/valid/example.henge.yaml'), 'utf8')) as HengeV1;
const H = 'example-org--resolved-forecasts';
const perms = { view: true, send: true, start_threads: true, mention_everyone: false, add_reactions: true, manage_messages: false, post_via_api: false };
const actor = (id: string, type = 'human', handle = id) => ({ id, type, handle, display_name: handle, avatar_url: `/v1/avatars/${id}?v=1`, owner: null });
const msg = (id: string, body: string) => ({
  id, henge_id: 'hng_1', channel_id: 'ch_general', author: actor('acc_demo', 'human', 'demo'), body, reply_to: null, thread_root: null, thread: null,
  mentions: { actor_ids: [], roles: [], everyone: false }, reactions: [], pinned: false, held: false, edited_at: null, deleted: false, created_at: '2026-11-26T10:00:00.000Z',
});

/** A fake of main's community bridge: canned answers per operation, and a record of every call. */
function fakeBridge() {
  const calls: Array<[string, unknown[]]> = [];
  let emit: (e: CommunityEventView) => void = () => undefined;
  const answers: Record<string, unknown> = {
    myProfile: { account_id: 'acc_demo', handle: 'demo', display_name: 'Demo', bio: '', avatar_url: null, handle_changed_at: null, created_at: '2026-11-26T10:00:00.000Z', agents: [] },
    getHenge: { henge: { id: 'hng_1' }, me: { actor_id: 'acc_demo', actor_type: 'human', roles: ['owner'], nickname: null, capabilities: [] }, report_reasons: [], timeout_presets: [] },
    listChannels: {
      categories: [{ id: 'cat_1', key: 'community', name: 'Community', position: 0 }],
      channels: [{ id: 'ch_general', key: 'general', name: 'general', topic: '', type: 'text', category_id: 'cat_1', position: 0, slow_mode_s: 10, public: true, agents_policy: null, glyph_posts: [], archived: false, my_perms: perms }],
    },
    listMembers: { items: [{ actor: actor('acc_demo', 'human', 'demo'), roles: ['owner'], nickname: null, joined_at: '2026-11-26T10:00:00.000Z', presence: 'online' }] },
    unread: { channels: [{ channel_id: 'ch_general', unread: 2, mentions: 1, last_message_id: null, last_read_message_id: null }], threads: [], total_unread: 2, total_mentions: 1 },
    listMessages: { items: [msg('msg_1', 'hello')], next_before: null },
    postMessage: msg('msg_2', 'sent'),
    auditLog: { items: [{ id: 'aud_1', actor: actor('acc_demo', 'human', 'demo'), action: 'member.timed_out', target_type: 'actor', target_id: 'agt_1', target: actor('agt_1', 'agent', 'demo.node'), reason: 'testing', payload: {}, created_at: '2026-11-26T10:00:00.000Z' }, { id: 'aud_2', actor: actor('acc_demo'), action: 'category.created', target_type: 'category', target_id: 'cat_1', target: null, reason: null, payload: {}, created_at: '2026-11-26T10:00:00.000Z' }], next_before: null },
    timeout: { actor_id: 'agt_1', until: '2026-11-26T11:00:00.000Z' },
  };
  const bridge = {
    call: async (op: string, ...args: unknown[]) => {
      calls.push([op, args]);
      return op in answers ? { ok: true as const, value: answers[op] } : { ok: false as const, status: 404, code: 'not_found', message: 'Not found.' };
    },
    uploadAvatar: async () => ({ ok: true as const, value: { avatar_url: null } }),
    createAgent: async () => ({ ok: true as const, value: { id: 'agt_1', handle: 'demo.node', display_name: 'local-node' } }),
    watch: async () => true,
    unwatch: async () => true,
    onEvent: (cb: (e: CommunityEventView) => void) => {
      emit = cb;
      return () => undefined;
    },
  };
  return { bridge: bridge as unknown as Window['swarm']['community'], calls, emit: (e: CommunityEventView) => emit(e) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('ApiCommunityStore', () => {
  it('keeps a Henge offline (file data only) until it has a community id, then reads the service', async () => {
    const f = fakeBridge();
    const s = new ApiCommunityStore(f.bridge, Promise.resolve('http://localhost:3000'));
    await settle();
    expect(s.myProfile()).toMatchObject({ handle: 'demo' });
    s.attachHenge({ hengeId: H, henge: EXAMPLE, myRole: 'member' });
    expect(s.connected(H)).toBe(false);
    expect(s.channels(H).map((c) => c.id)).toContain('general'); // From the file.
    expect((await s.send(H, 'general', 'x')).ok).toBe(false);

    s.attachHenge({ hengeId: H, henge: EXAMPLE, myRole: 'member', communityId: 'hng_1' });
    await settle();
    expect(s.connected(H)).toBe(true);
    expect(s.channels(H)).toEqual([expect.objectContaining({ id: 'general', categoryName: 'Community', slowModeS: 10 })]);
    expect(s.members(H)[0]).toMatchObject({ handle: 'demo', you: true, avatar: 'http://localhost:3000/v1/avatars/acc_demo?v=1' });
    expect(s.unread(H, 'general')).toEqual({ count: 2, mentions: 1 });
    expect(s.can(H, 'general', 'owner', 'threads')).toBe(true); // start_threads on the service.
    expect(s.can(H, 'general', 'owner', 'manage')).toBe(false); // manage_messages.
  });

  it('sends by service channel id, maps moderation presets and labels unknown audit actions', async () => {
    const f = fakeBridge();
    const s = new ApiCommunityStore(f.bridge, Promise.resolve(null));
    s.attachHenge({ hengeId: H, henge: EXAMPLE, myRole: 'owner', communityId: 'hng_1' });
    await settle();
    s.messages(H, 'general');
    await settle();
    expect(s.messages(H, 'general').map((m) => m.body)).toEqual(['hello']);
    const r = await s.send(H, 'general', 'sent');
    expect(r.ok).toBe(true);
    expect(f.calls.find(([op]) => op === 'postMessage')?.[1]).toEqual(['hng_1', 'ch_general', { body: 'sent' }]);

    expect((await s.moderate(H, { kind: 'timeout', targetId: 'agt_1', minutes: 7, reason: 'testing' })).ok).toBe(true);
    expect(f.calls.find(([op]) => op === 'timeout')?.[1]).toEqual(['hng_1', 'agt_1', '10m', 'testing']);
    s.auditLog(H);
    await settle();
    expect(s.auditLog(H)).toEqual([expect.objectContaining({ action: 'timeout', target: 'demo.node' }), expect.objectContaining({ action: 'other', label: 'category.created' })]);
  });

  it('applies realtime messages from the stream', async () => {
    const f = fakeBridge();
    const s = new ApiCommunityStore(f.bridge, Promise.resolve(null));
    s.attachHenge({ hengeId: H, henge: EXAMPLE, myRole: 'owner', communityId: 'hng_1' });
    await settle();
    f.emit({ id: 'e1', kind: 'message.created', henge_id: 'hng_1', channel_id: 'ch_general', payload: { message: msg('msg_9', 'from the stream') }, created_at: '2026-11-26T10:00:00.000Z' });
    expect(s.message('msg_9')).toMatchObject({ channelId: 'general', body: 'from the stream' });
  });
});
