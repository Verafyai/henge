import { describe, expect, it } from 'vitest';
import { subscribeHengeEvents, type CommunityEvent } from './community';

const ev = (id: string, kind = 'message.created') =>
  `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify({ id, kind, henge_id: 'h', channel_id: null, payload: { n: id }, created_at: '2026-11-26T00:00:00.000Z' })}\n\n`;

/** A fetch that serves the given streams in order, split into awkward chunks. */
function fakeFetch(streams: string[][], seen: Headers[]): typeof fetch {
  let i = 0;
  return (async (_url: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    const chunks = streams[Math.min(i++, streams.length - 1)]!;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

describe('subscribeHengeEvents', () => {
  it('parses split chunks, resumes with Last-Event-ID and drops duplicates', async () => {
    const a = ev('01A');
    const b = ev('01B');
    const c = ev('01C');
    const seen: Headers[] = [];
    const got: CommunityEvent[] = [];
    const sub = subscribeHengeEvents({
      url: 'http://x/v1/henges/h/events',
      headers: async () => ({ authorization: 'Bearer t' }),
      fetch: fakeFetch(
        [
          ['retry: 5\n\n: ping\n', a.slice(0, 7), a.slice(7) + b.replace(/\n/g, '\r\n')],
          [b + c, `event: closed\ndata: {"reason":"left"}\n\n`],
        ],
        seen,
      ),
      onEvent: (e) => got.push(e),
    });
    await sub.done;
    expect(got.map((e) => e.id)).toEqual(['01A', '01B', '01C']);
    expect(seen[0]!.get('last-event-id')).toBeNull();
    expect(seen[1]!.get('last-event-id')).toBe('01B');
    expect(seen[1]!.get('authorization')).toBe('Bearer t');
    expect(sub.lastEventId).toBe('01C');
  });

  it('stops on 403 and reports it as fatal', async () => {
    const errors: [number, boolean][] = [];
    const sub = subscribeHengeEvents({
      url: 'http://x/v1/henges/h/events',
      headers: async () => ({}),
      fetch: (async () => Response.json({ error: { code: 'banned', message: 'You are banned from this Henge.' } }, { status: 403 })) as typeof fetch,
      onEvent: () => undefined,
      onError: (e, fatal) => errors.push([(e as { status: number }).status, fatal]),
    });
    await sub.done;
    expect(errors).toEqual([[403, true]]);
  });
});
