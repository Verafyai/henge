/**
 * Kill switch watcher (SPEC 11.6, M7). The node polls the signed revocation feed on its own timer,
 * so a platform or swarm stop reaches it within 60 seconds even when it is idle and has no lease to
 * renew. Every entry is checked against trusted keys before it counts; an unsigned or wrongly signed
 * entry is ignored. A stop aborts the running task and qualification, and the reason is shown.
 *
 * Fail closed for new work: if the feed has not been read successfully in the last 60 seconds, no
 * new lease or qualification starts. A running task is not stopped by a missed poll alone; the
 * coordinator also cancels its lease on a stop, which the runner sees on its next call.
 */
import type { RevocationEntry } from '@swarm-explorer/api-client';
import { killStateOf, verifiedRevocation, type KillState, type PlatformPublicKey, type RevocationPayload } from '@swarm-explorer/schema/node';
import type { KillView } from '../shared/node';

/** The longest a stop may take to reach an online node (M7 requirement). */
export const KILL_BOUND_MS = 60_000;
/** Poll interval and per request timeout. Engineering values: 15 s + 10 s stays well inside the bound. */
export const KILL_POLL_MS = 15_000;
export const KILL_TIMEOUT_MS = 10_000;

export type KillFeed = { items: RevocationEntry[]; keys: PlatformPublicKey[] };

type Deps = {
  fetchFeed: (signal: AbortSignal) => Promise<KillFeed>;
  /**
   * Keys pinned at build time (MAIN_VITE_REVOCATION_PUBKEYS). Null only in unpackaged test builds,
   * which trust the keys the feed lists; a packaged build without pinned keys trusts nothing.
   */
  pinnedKeys: PlatformPublicKey[] | null;
  /** Called when the kill state changes, with the new state. */
  onChange: (state: KillState) => void;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
};

const sameState = (a: KillState, b: KillState) =>
  (a.global?.id ?? null) === (b.global?.id ?? null) && JSON.stringify(Object.keys(a.swarms).sort().map((k) => a.swarms[k]!.id)) === JSON.stringify(Object.keys(b.swarms).sort().map((k) => b.swarms[k]!.id));

/** Parses `key_id=base64url,key_id=base64url` from the build. */
export function parsePinnedKeys(v: string | undefined | null): PlatformPublicKey[] | null {
  if (!v) return null;
  const keys = v
    .split(',')
    .map((p) => p.trim().split('='))
    .filter((p): p is [string, string] => p.length === 2 && Boolean(p[0]) && Boolean(p[1]))
    .map(([key_id, public_key]) => ({ key_id, public_key, status: 'active' as const }));
  return keys.length ? keys : null;
}

export class KillSwitchWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: KillState = { global: null, swarms: {} };
  private checkedAt: number | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private d: Deps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  start() {
    this.timer ??= setInterval(() => void this.check(), this.d.pollMs ?? KILL_POLL_MS);
    void this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads the feed now (also called when a lease call answers `killed` or `lease_cancelled`). */
  check(): Promise<void> {
    this.inflight ??= this.read().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async read() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.d.timeoutMs ?? KILL_TIMEOUT_MS);
    try {
      const feed = await this.d.fetchFeed(ctl.signal);
      const keys = this.d.pinnedKeys ?? feed.keys;
      const verified = feed.items.map((e) => verifiedRevocation(e, keys)).filter((e): e is RevocationPayload => e !== null);
      const next = killStateOf(verified, new Date(this.now()));
      this.checkedAt = this.now();
      if (!sameState(this.state, next)) {
        this.state = next;
        this.d.onChange(next);
      }
    } catch {
      // Offline or slow: the last state stands, and freshness runs out on its own.
    } finally {
      clearTimeout(t);
    }
  }

  /** True when the feed was read in the last 60 seconds. */
  fresh(): boolean {
    return this.checkedAt !== null && this.now() - this.checkedAt <= KILL_BOUND_MS;
  }

  /** Why work for this swarm (or any work, without one) is stopped, or null. */
  stoppedReason(swarm?: string): string | null {
    if (this.state.global) return `Verafy has stopped all work for now: ${this.state.global.reason}`;
    const s = swarm ? this.state.swarms[swarm] : undefined;
    return s ? `Verafy has stopped work for ${swarm}: ${s.reason}` : null;
  }

  /** Why no new work may start: a stop, or a feed that has not been checked recently. */
  startBlock(swarm?: string): string | null {
    return this.stoppedReason(swarm) ?? (this.fresh() ? null : 'Waiting to check for platform stops before starting work.');
  }

  view(joined: string[] = []): KillView {
    const swarms = Object.values(this.state.swarms)
      .filter((s) => !joined.length || joined.includes(s.target_id))
      .map((s) => ({ swarm: s.target_id, reason: s.reason, at: s.effective_at }));
    const global = this.state.global ? { reason: this.state.global.reason, at: this.state.global.effective_at } : null;
    return { status: global || swarms.length ? 'stopped' : this.fresh() ? 'ok' : 'unchecked', global, swarms, checkedAt: this.checkedAt };
  }

  /** Stopped swarms, so the caller can delete their cached harness bundles (SPEC 15.2). */
  stoppedSwarms(): string[] {
    return Object.keys(this.state.swarms);
  }
}
