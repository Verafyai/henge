import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { HengeV1 } from '@swarm-explorer/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { InMemoryCommunityStore } from './memory';

const EXAMPLE = parse(readFileSync(path.resolve(__dirname, '../../../../../packages/schema/fixtures/henge/valid/example.henge.yaml'), 'utf8')) as HengeV1;
const H = 'example-org--resolved-forecasts';

let t = 1_000_000;
let s: InMemoryCommunityStore;
beforeEach(async () => {
  t = 1_000_000;
  s = new InMemoryCommunityStore(() => t);
  s.attachHenge({ hengeId: H, henge: EXAMPLE, myRole: 'owner' });
  await s.saveProfile({ handle: 'demo', displayName: 'Demo', bio: '', avatar: null });
});

describe('InMemoryCommunityStore', () => {
  it('refuses reserved and taken handles', async () => {
    expect(await s.checkHandle('admin')).toMatchObject({ ok: false, message: 'That handle is reserved.' });
    expect(await s.checkHandle('example-owner')).toMatchObject({ ok: false });
    expect(await s.checkHandle('night_owl')).toMatchObject({ ok: true });
  });

  it('enforces slow mode from the .henge file', async () => {
    expect((await s.send(H, 'general', 'first')).ok).toBe(true);
    const second = await s.send(H, 'general', 'second');
    expect(second.ok).toBe(false);
    t += 11_000;
    expect((await s.send(H, 'general', 'third')).ok).toBe(true);
  });

  it('reports dedupe per reporter, queue for mods and resolve into the audit log', async () => {
    const m = await s.send(H, 'general', 'reported text');
    if (!m.ok) throw new Error(m.message);
    expect((await s.report(m.value.id, 'spam')).ok).toBe(true);
    expect(await s.report(m.value.id, 'spam')).toMatchObject({ ok: false, message: 'You already reported this message.' });
    const [r] = s.reports(H);
    expect(r).toMatchObject({ status: 'open', snapshot: { body: 'reported text' } });
    expect((await s.resolveReport(r!.id, 'dismiss')).ok).toBe(true);
    expect(s.reports(H)[0]).toMatchObject({ status: 'dismissed' });
    expect(s.auditLog(H)[0]).toMatchObject({ action: 'report_dismissed' });
  });

  it('proposals are posted by the Governance Glyph and votes are recorded, never applied', async () => {
    const p = await s.openProposal({ hengeId: H, channelId: 'proposals', glyphId: 'verafy/governance', title: 'Change quorum', body: 'x', changes: { 'voting.quorum': 0.3 } });
    if (!p.ok) throw new Error(p.message);
    expect(p.value.number).toBe(1);
    const msg = s.messages(H, 'proposals').at(-1)!;
    expect(msg).toMatchObject({ authorType: 'glyph' });
    expect((await s.vote(p.value.id, 'yes')).ok).toBe(true);
    expect(s.proposal(p.value.id)).toMatchObject({ status: 'open' });
  });
});
