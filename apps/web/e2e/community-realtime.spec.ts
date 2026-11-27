import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createCommunityClient, type CommunityClient, type CommunityEvent } from '@swarm-explorer/api-client';

/**
 * Spin-out spec 8.3: two clients in one channel see each other's messages, edits, reactions and typing.
 * Two example users sign in through the real OAuth flow against the running server, open the SSE stream
 * and measure delivery latency: from just before the sender's API write to the moment the other client
 * reads the event off its stream. The measured numbers are printed and attached to the report.
 */
const BASE = `http://localhost:${process.env.PORT ?? 3000}`;
const REDIRECT = 'http://127.0.0.1:53117/callback';
const SAMPLES = 10;

async function bearerFor(handle: string): Promise<string> {
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: BASE };
  const signIn = await fetch(`${BASE}/v1/dev/sign-in`, { method: 'POST', headers, body: form({ handle, next: '/' }), redirect: 'manual' });
  expect(signIn.status).toBe(303);
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authz = await fetch(`${BASE}/v1/oauth/authorize`, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: form({ response_type: 'code', client_id: 'swarm-explorer-desktop', redirect_uri: REDIRECT, state: randomBytes(16).toString('base64url'), code_challenge: challenge, code_challenge_method: 'S256', decision: 'allow' }),
    redirect: 'manual',
  });
  expect(authz.status).toBe(303);
  const code = new URL(authz.headers.get('location')!).searchParams.get('code')!;
  const pub = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const token = await fetch(`${BASE}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', client_id: 'swarm-explorer-desktop', code, code_verifier: verifier, redirect_uri: REDIRECT, device_platform: 'darwin', device_arch: 'arm64', app_version: '0.2.0', channel: 'dev', device_pubkey: pub }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

/** The spec's example `.henge` file, with open admission and `demo` as the owner. */
function hengeSource(): string {
  const file = fileURLToPath(new URL('../../../packages/schema/fixtures/henge/valid/example.henge.yaml', import.meta.url));
  return readFileSync(file, 'utf8')
    .replace(/^ {2}mode: request(\s)/m, '  mode: open$1')
    .replace(/^id: example-org\/resolved-forecasts/m, `id: e2e-org/realtime-${randomBytes(4).toString('hex')}`)
    .replace('owner: [example-owner]', 'owner: [demo]');
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { n: s.length, min: Math.round(s[0]!), median: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(s[s.length - 1]!) };
};

test('two clients in one channel: messages, edits, reactions and typing arrive within 1 s (measured)', async ({ browserName }, testInfo) => {
  void browserName;
  test.setTimeout(120_000);
  const [tokA, tokB] = [await bearerFor('demo'), await bearerFor('reviewer')];
  const a: CommunityClient = createCommunityClient({ baseUrl: BASE, getAccessToken: () => tokA });
  const b: CommunityClient = createCommunityClient({ baseUrl: BASE, getAccessToken: () => tokB });
  await a.saveProfile({ handle: 'demo', display_name: 'Demo' }).catch(() => a.myProfile());
  await b.saveProfile({ handle: 'reviewer', display_name: 'Reviewer' }).catch(() => b.myProfile());
  const { henge } = await a.createOrJoin(hengeSource());
  await b.join(henge.id);
  const channel = (await a.listChannels(henge.id)).channels.find((c) => c.key === 'introductions')!;

  // Both clients listen; each arrival is stamped the moment it comes off the stream. The two take turns
  // sending (the seeded accounts are new, so each may post 5 messages a minute).
  const key = (e: CommunityEvent) => {
    const p = e.payload as { message?: { id: string; body: string }; message_id?: string; emoji?: string; thread_root?: string };
    if (e.kind === 'message.created' || e.kind === 'message.updated') return `${e.kind}:${p.message!.id}:${p.message!.body}`;
    if (e.kind === 'reaction.added') return `${e.kind}:${p.message_id}:${p.emoji}`;
    if (e.kind === 'typing') return `${e.kind}:${p.thread_root}`;
    return null;
  };
  const listen = (c: CommunityClient) => {
    const arrivals = new Map<string, number>();
    let opened = false;
    const sub = c.events(henge.id, {
      onEvent: (e) => {
        const k = key(e);
        if (k && !arrivals.has(k)) arrivals.set(k, performance.now());
      },
      onOpen: () => (opened = true),
    });
    return { arrivals, sub, opened: () => opened };
  };
  const la = listen(a);
  const lb = listen(b);
  await expect.poll(() => la.opened() && lb.opened()).toBe(true);
  await new Promise((r) => setTimeout(r, 500));

  const lat = { message: [] as number[], edit: [] as number[], reaction: [] as number[], typing: [] as number[] };
  const emoji = ['👍', '🔥', '🎉', '👀', '✅', '🙏', '💡', '🚀', '❤️', '😀'];
  for (let i = 0; i < SAMPLES; i++) {
    const [from, to] = i % 2 === 0 ? [a, lb] : [b, la];
    const waitFor = async (k: string) => {
      await expect.poll(() => to.arrivals.has(k), { timeout: 5000, intervals: [5] }).toBe(true);
      return to.arrivals.get(k)!;
    };
    let t0 = performance.now();
    const m = await from.postMessage(henge.id, channel.id, { body: `latency sample ${i}` });
    lat.message.push((await waitFor(`message.created:${m.id}:latency sample ${i}`)) - t0);

    t0 = performance.now();
    await from.editMessage(henge.id, m.id, `latency sample ${i} (edited)`);
    lat.edit.push((await waitFor(`message.updated:${m.id}:latency sample ${i} (edited)`)) - t0);

    t0 = performance.now();
    await from.addReaction(henge.id, m.id, emoji[i]!);
    lat.reaction.push((await waitFor(`reaction.added:${m.id}:${emoji[i]}`)) - t0);

    // Typing in this message's thread (typing is throttled per channel and thread on the server).
    t0 = performance.now();
    await from.typing(henge.id, channel.id, m.id);
    lat.typing.push((await waitFor(`typing:${m.id}`)) - t0);
  }
  la.sub.close();
  lb.sub.close();

  const report = { samples_per_kind: SAMPLES, poll_ms: Number(process.env.COMMUNITY_POLL_MS ?? 250), ms: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stats(v)])) };
  console.log(`community realtime latency (ms): ${JSON.stringify(report)}`);
  await testInfo.attach('community-latency.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  for (const v of Object.values(lat)) expect(Math.max(...v)).toBeLessThan(1000);
});
