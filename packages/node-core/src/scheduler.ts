/**
 * Node timeshare scheduler (SPEC 7.1): weighted fair queueing across joined swarms.
 *
 * Each swarm keeps a virtual time that advances by the work it received divided by its share, so
 * the eligible swarm furthest below its share has the lowest virtual time and goes next. This is
 * start-time fair queueing:
 *
 * - Lending: a swarm with no tasks is skipped and its time goes to the others. Its configured share
 *   never changes. When it has work again it re-enters at the current virtual time, so it gets its
 *   share from then on instead of a burst that "repays" the time it lent.
 * - Urgent: a swarm with urgent tasks goes first, but the run is still charged to its share. Repeated
 *   urgency pushes its virtual time ahead of the others, shown as a deficit that the other swarms
 *   win back before it runs normal work again.
 * - A swarm with a 0 share (for example one that just joined beside customized shares) only borrows
 *   lent time: it runs only when no swarm with a share has work.
 *
 * State is per session and in memory; it holds no secrets and nothing leaves the device.
 */
/** Shares are basis points of a node's time; a node's shares sum to 10,000 (SPEC 7.1). */
const TOTAL_SHARE_BP = 10_000;

export type SwarmSlot = {
  id: string;
  shareBp: number;
  /** Membership is active, qualified, permissions granted and a model fits. */
  eligible: boolean;
  /** Tasks the coordinator reports waiting, or that are assumed to be waiting. */
  queued: number;
  urgent: number;
};

type State = { vt: number; shareBp: number; servedMs: number; urgentMs: number; runs: number; backlogged: boolean };

export type ShareReport = { id: string; shareBp: number; servedMs: number; urgentMs: number; runs: number; deficitMs: number };

export class FairShareScheduler {
  private s = new Map<string, State>();
  private clock = 0;

  private get(id: string, shareBp: number): State {
    let st = this.s.get(id);
    if (!st) {
      st = { vt: this.clock, shareBp, servedMs: 0, urgentMs: 0, runs: 0, backlogged: false };
      this.s.set(id, st);
    }
    st.shareBp = shareBp;
    return st;
  }

  /** The virtual time of the slowest backlogged swarm with a share: where a returning swarm re-enters. */
  private floor(): number {
    const vts = [...this.s.values()].filter((x) => x.backlogged && x.shareBp > 0).map((x) => x.vt);
    return vts.length ? Math.min(...vts) : this.clock;
  }

  /**
   * The order in which to ask swarms for a lease: urgent work first, then swarms with a share by how
   * far below it they are, then 0-share swarms that only borrow lent time.
   */
  order(slots: readonly SwarmSlot[]): string[] {
    const ready = slots.filter((x) => x.eligible && x.queued > 0);
    const readyIds = new Set(ready.map((x) => x.id));
    for (const [id, st] of this.s) if (!readyIds.has(id)) st.backlogged = false;
    const floor = this.floor();
    for (const x of ready) {
      const st = this.get(x.id, x.shareBp);
      if (!st.backlogged) {
        st.vt = Math.max(st.vt, floor);
        st.backlogged = true;
      }
    }
    return ready
      .slice()
      .sort((a, b) => {
        const ua = a.urgent > 0 ? 0 : 1;
        const ub = b.urgent > 0 ? 0 : 1;
        if (ua !== ub) return ua - ub;
        const za = a.shareBp > 0 ? 0 : 1;
        const zb = b.shareBp > 0 ? 0 : 1;
        if (za !== zb) return za - zb;
        return this.s.get(a.id)!.vt - this.s.get(b.id)!.vt || b.shareBp - a.shareBp || a.id.localeCompare(b.id);
      })
      .map((x) => x.id);
  }

  /** The coordinator had nothing for this swarm: it lends its time until it reports work again. */
  markIdle(id: string) {
    const st = this.s.get(id);
    if (st) st.backlogged = false;
  }

  /** Charges a finished, abandoned or failed run to the swarm's share, urgent or not. */
  charge(id: string, ms: number, urgent = false) {
    const st = this.s.get(id);
    if (!st || ms <= 0) return;
    this.clock = Math.max(this.clock, st.vt);
    if (st.shareBp > 0) st.vt += (ms * TOTAL_SHARE_BP) / st.shareBp;
    st.servedMs += ms;
    st.runs += 1;
    if (urgent) st.urgentMs += ms;
  }

  /**
   * Per-swarm accounting. `deficitMs` is how much time a swarm has used ahead of its share relative
   * to the slowest backlogged swarm, for example after urgent runs. Lent time creates no deficit.
   */
  report(): ShareReport[] {
    const floor = this.floor();
    return [...this.s.entries()].map(([id, st]) => ({
      id,
      shareBp: st.shareBp,
      servedMs: st.servedMs,
      urgentMs: st.urgentMs,
      runs: st.runs,
      deficitMs: st.backlogged && st.shareBp > 0 ? Math.max(0, Math.round(((st.vt - floor) * st.shareBp) / TOTAL_SHARE_BP)) : 0,
    }));
  }

  /** Forgets a swarm, for example after leave. */
  remove(id: string) {
    this.s.delete(id);
  }
}
