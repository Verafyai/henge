/**
 * Realtime delivery for the community layer (decision 2026-11-26: no new vendor).
 *
 * Postgres is the source of truth. Writes go through API routes, which append a compact row to
 * `community_events` in the same request. Each server instance runs one poller for the Henges that have
 * open streams on it and fans rows out to its Server-Sent Events subscribers. Event ids are ULIDs, so a
 * client resumes with `Last-Event-ID`.
 *
 * Rows can commit slightly out of id order (two instances, two transactions). The poller therefore
 * re-reads a short window behind the newest id it has seen and each subscriber drops ids it already
 * delivered; a resuming client gets the same window again and drops duplicates by id.
 *
 * `RealtimeTransport` is the seam for replacing this with Ably or another vendor later.
 */
import { communityEvents, getDb, ulidFloor, ulidTime } from '@swarm-explorer/db';
import { and, asc, gt, inArray } from 'drizzle-orm';

export type StoredEvent = typeof communityEvents.$inferSelect;
export type Unsubscribe = () => void;

export interface RealtimeTransport {
  /** Calls `onEvents` with every event for the Henge after `after` (a ULID), including late commits. */
  subscribe(hengeId: string, after: string | null, onEvents: (events: StoredEvent[]) => void): Unsubscribe;
}

/** How far behind the newest event the poller re-reads, to catch rows that committed late. */
export const LATE_WINDOW_MS = 3000;
export const POLL_MS = Number(process.env.COMMUNITY_POLL_MS ?? 250);
const BATCH = 2000;

type Sub = { hengeId: string; floor: string; seen: Map<string, number>; onEvents: (events: StoredEvent[]) => void };

export class PostgresPollTransport implements RealtimeTransport {
  private subs = new Set<Sub>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  constructor(private readonly pollMs = POLL_MS) {}

  subscribe(hengeId: string, after: string | null, onEvents: (events: StoredEvent[]) => void): Unsubscribe {
    // Resume a little before the cursor to catch late commits; the subscriber de-duplicates.
    const from = after ? ulidFloor(ulidTime(after) - LATE_WINDOW_MS) : ulidFloor(Date.now() - 50);
    const sub: Sub = { hengeId, floor: from, seen: new Map(after ? [[after, Date.now()]] : []), onEvents };
    this.subs.add(sub);
    this.schedule(0);
    return () => {
      this.subs.delete(sub);
    };
  }

  private schedule(ms: number) {
    if (this.timer || !this.subs.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => this.schedule(this.pollMs));
    }, ms);
    // Never keep a process alive just for polling.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async poll() {
    if (this.polling || !this.subs.size) return;
    this.polling = true;
    try {
      const byHenge = new Map<string, Sub[]>();
      for (const s of this.subs) byHenge.set(s.hengeId, [...(byHenge.get(s.hengeId) ?? []), s]);
      const floor = [...this.subs].reduce((m, s) => (s.floor < m ? s.floor : m), ulidFloor(Date.now() - LATE_WINDOW_MS));
      const db = await getDb();
      const rows = await db
        .select()
        .from(communityEvents)
        .where(and(inArray(communityEvents.hengeId, [...byHenge.keys()]), gt(communityEvents.id, floor)))
        .orderBy(asc(communityEvents.id))
        .limit(BATCH);
      const now = Date.now();
      const truncated = rows.length === BATCH;
      const windowFloor = ulidFloor(now - LATE_WINDOW_MS);
      for (const [hengeId, subs] of byHenge) {
        const mine = rows.filter((r) => r.hengeId === hengeId);
        for (const s of subs) {
          const fresh = mine.filter((r) => r.id > s.floor && !s.seen.has(r.id));
          for (const r of fresh) s.seen.set(r.id, now);
          // Once caught up, only the late window needs re-reading; while catching up, continue after the batch.
          const next = truncated ? rows[rows.length - 1]!.id : windowFloor;
          if (s.floor < next) s.floor = next;
          for (const [id, t] of s.seen) if (now - t > LATE_WINDOW_MS * 3) s.seen.delete(id);
          if (fresh.length) s.onEvents(fresh);
        }
      }
    } catch {
      // A failed poll is retried on the next tick.
    } finally {
      this.polling = false;
    }
  }
}

const g = globalThis as unknown as { __hengeRealtime?: RealtimeTransport };

export function realtime(): RealtimeTransport {
  g.__hengeRealtime ??= new PostgresPollTransport();
  return g.__hengeRealtime;
}

/** For tests or a future vendor: swap the process-wide transport. */
export function setRealtimeTransport(t: RealtimeTransport) {
  g.__hengeRealtime = t;
}
