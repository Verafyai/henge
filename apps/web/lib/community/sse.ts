/**
 * `GET /v1/henges/{id}/events`: a Server-Sent Events stream of one Henge's community events.
 *
 * Each event carries its ULID as the SSE `id`, so a reconnecting client sends `Last-Event-ID` and
 * resumes. Events are filtered per subscriber: channels they cannot view, events addressed to other
 * actors (read markers, held messages, report outcomes) and moderator-only events are dropped.
 * Streams close after `STREAM_MAX_MS` (below the function time limit); clients reconnect.
 */
import { access, CAPABILITIES, can, ULID_RE, viewableChannelIds, type Access } from '@swarm-explorer/db';
import { realtime, type StoredEvent } from './realtime';

export const STREAM_MAX_MS = Number(process.env.COMMUNITY_STREAM_MAX_MS ?? 270_000);
const PING_MS = 15_000;
const REFRESH_MS = 30_000;
const REFRESH_KINDS = new Set(['channel.created', 'channel.updated', 'roles.updated']);

export async function eventStream(req: Request, first: Access): Promise<Response> {
  const header = req.headers.get('last-event-id') ?? new URL(req.url).searchParams.get('after');
  const after = header && ULID_RE.test(header) ? header : null;
  let acc = first;
  let viewable = await viewableChannelIds(acc);
  let caps = new Set<string>(CAPABILITIES.filter((c) => can(acc, c)));
  let refreshedAt = Date.now();
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      const refresh = async (): Promise<boolean> => {
        try {
          acc = await access(acc.actor, acc.henge.id);
        } catch {
          return false;
        }
        viewable = await viewableChannelIds(acc);
        caps = new Set(CAPABILITIES.filter((c) => can(acc, c)));
        refreshedAt = Date.now();
        return true;
      };
      const allowed = (ev: StoredEvent) => {
        const p = ev.payload as Record<string, unknown>;
        if (ev.audience && !ev.audience.includes(acc.actor.id)) return false;
        if (typeof p._cap === 'string' && !caps.has(p._cap)) return false;
        if (ev.channelId && !viewable.has(ev.channelId)) return false;
        return true;
      };
      const format = (ev: StoredEvent) => {
        const { _cap: _drop, ...payload } = ev.payload as Record<string, unknown>;
        void _drop;
        const data = { id: ev.id, kind: ev.kind, henge_id: ev.hengeId, channel_id: ev.channelId, payload, created_at: ev.createdAt.toISOString() };
        return `id: ${ev.id}\nevent: ${ev.kind}\ndata: ${JSON.stringify(data)}\n\n`;
      };

      const queue: StoredEvent[] = [];
      let draining = false;
      const drain = async () => {
        if (draining) return;
        draining = true;
        try {
          while (queue.length && !closed) {
            const ev = queue.shift()!;
            const p = ev.payload as Record<string, unknown>;
            const aboutMe = p.actor_id === acc.actor.id || (Array.isArray(p.removed) && p.removed.includes(acc.actor.id));
            if (REFRESH_KINDS.has(ev.kind) || (aboutMe && ev.kind === 'member.updated') || Date.now() - refreshedAt > REFRESH_MS) {
              if (!(await refresh())) {
                send(`event: closed\ndata: ${JSON.stringify({ reason: 'access_ended' })}\n\n`);
                cleanup();
                return;
              }
            }
            if (aboutMe && (ev.kind === 'member.left' || ev.kind === 'member.banned')) {
              send(format(ev));
              send(`event: closed\ndata: ${JSON.stringify({ reason: ev.kind === 'member.banned' ? 'banned' : 'left' })}\n\n`);
              cleanup();
              return;
            }
            if (allowed(ev)) send(format(ev));
          }
        } finally {
          draining = false;
        }
      };

      const unsubscribe = realtime().subscribe(acc.henge.id, after, (events) => {
        queue.push(...events);
        void drain();
      });
      const ping = setInterval(() => send(': ping\n\n'), PING_MS);
      const lifetime = setTimeout(() => {
        send(`event: closed\ndata: ${JSON.stringify({ reason: 'reconnect' })}\n\n`);
        cleanup();
      }, STREAM_MAX_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(ping);
        clearTimeout(lifetime);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      req.signal.addEventListener('abort', () => cleanup());
      send('retry: 2000\n\n');
      send(`event: ready\ndata: ${JSON.stringify({ henge_id: acc.henge.id, after })}\n\n`);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform keeps compression middleware from buffering the stream.
      'cache-control': 'no-store, no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
