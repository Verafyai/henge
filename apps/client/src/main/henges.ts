/**
 * Joined Henges on this device (spin-out spec v2, 6.5 step 5): the pin `{url, commit or etag,
 * bundle_digest, version}`, the member's own cap, the pinned manifest for diffing updates and an
 * update waiting for re-consent. Kept in the encrypted cache. The JoinWorkflow and
 * BundleUpdateWorkflow write here through their activities.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { resolveHenge, type HengeResolveResult, type HengeV1, type ResolveDeps } from '@swarm-explorer/schema';
import type { EncryptedCache } from './cache';
import type { BundleActivityDeps } from './temporal/activities';
import type { HengePinRecord } from './temporal/types';

const PINS = 'henge-pins';

/** Real network access for the resolver: manual redirects (it checks each hop) and every address of a host. */
export const resolveDeps: ResolveDeps = {
  fetch: (url, init) => fetch(url, init),
  lookup: async (host) => {
    if (isIP(host)) return [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
    const all = await lookup(host, { all: true });
    return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  },
};

export class HengeStore {
  private held = new Set<string>();

  constructor(
    private d: {
      cache: () => EncryptedCache;
      /** A Henge's update needs re-consent (true) or got it (false). */
      onHold: (held: ReadonlySet<string>) => void;
      resolve?: (url: string) => Promise<HengeResolveResult>;
    },
  ) {}

  list(): HengePinRecord[] {
    return this.d.cache().get<HengePinRecord[]>(PINS) ?? [];
  }

  get(id: string): HengePinRecord | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  set(p: HengePinRecord) {
    this.d.cache().set(PINS, [...this.list().filter((x) => x.id !== p.id), p]);
  }

  /** Member caps of joined Henges, for the daily cap guard. */
  caps(): Array<number | null> {
    return this.list().map((p) => p.dailyCapUsdMicros);
  }

  heldIds(): ReadonlySet<string> {
    return new Set([...this.held, ...this.list().filter((p) => p.status === 'awaiting_reconsent').map((p) => p.id)]);
  }

  activityDeps(): BundleActivityDeps {
    return {
      resolve: this.d.resolve ?? ((url) => resolveHenge(url, resolveDeps)),
      pins: { get: (id) => this.get(id), set: (p) => this.set(p) },
      manifests: {
        get: (id) => this.d.cache().get<HengeV1>(`henge-manifest:${id}`),
        set: (id, h) => this.d.cache().set(`henge-manifest:${id}`, h),
        getPending: (id) => this.d.cache().get<HengeV1>(`henge-manifest-pending:${id}`),
        setPending: (id, h) => (h ? this.d.cache().set(`henge-manifest-pending:${id}`, h) : this.d.cache().delete(`henge-manifest-pending:${id}`)),
      },
      hold: (id, held) => {
        if (held) this.held.add(id);
        else this.held.delete(id);
        this.d.onHold(this.heldIds());
      },
    };
  }
}
