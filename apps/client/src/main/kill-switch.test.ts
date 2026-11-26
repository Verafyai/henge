import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { RevocationEntry } from '@swarm-explorer/api-client';
import { REVOCATION_PREFIX, revocationCanonical, signStatement, type PlatformPublicKey } from '@swarm-explorer/schema/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KILL_BOUND_MS, KillSwitchWatcher, parsePinnedKeys, type KillFeed } from './kill-switch';

const { privateKey } = generateKeyPairSync('ed25519');
const KEY = { keyId: 'revocation-test', privateKey };
const PUB: PlatformPublicKey = { key_id: KEY.keyId, public_key: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url'), status: 'active' };
let n = 0;

function entry(o: { target: 'platform' | 'swarm'; id?: string; action?: 'revoke' | 'restore'; at: number; key?: typeof KEY; reason?: string }): RevocationEntry {
  const payload = {
    revocation_version: 1 as const,
    id: `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    target_type: o.target,
    target_id: o.id ?? '*',
    action: o.action ?? 'revoke',
    reason: o.reason ?? 'Test stop',
    severity: 'critical' as const,
    effective_at: new Date(o.at).toISOString(),
  };
  const signedPayload = revocationCanonical(payload);
  return {
    id: payload.id,
    targetType: o.target,
    targetId: payload.target_id,
    reason: payload.reason,
    severity: 'critical',
    signedPayload,
    effectiveAt: payload.effective_at,
    action: payload.action,
    signature: signStatement(REVOCATION_PREFIX, signedPayload, o.key ?? KEY),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

function watcher(feed: () => Promise<KillFeed> | KillFeed, pinned: PlatformPublicKey[] | null = null) {
  const changes: number[] = [];
  const w = new KillSwitchWatcher({ fetchFeed: async () => feed(), pinnedKeys: pinned, onChange: () => changes.push(Date.now()) });
  return { w, changes };
}

describe('kill switch watcher (SPEC 11.6, M7)', () => {
  it('an idle node learns of a stop within 60 seconds, wherever in the poll cycle it lands', async () => {
    // Try a stop landing at every second of a poll cycle; none may take longer than the bound.
    for (let offset = 0; offset < 16; offset++) {
      vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
      const items: RevocationEntry[] = [];
      const { w, changes } = watcher(() => ({ items, keys: [PUB] }));
      w.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(w.view().status).toBe('ok');
      await vi.advanceTimersByTimeAsync(offset * 1000 + 1);
      const killedAt = Date.now();
      items.push(entry({ target: 'platform', at: killedAt }));
      await vi.advanceTimersByTimeAsync(KILL_BOUND_MS);
      expect(changes).toHaveLength(1);
      expect(changes[0]! - killedAt).toBeLessThanOrEqual(KILL_BOUND_MS);
      expect(w.stoppedReason()).toBe('Verafy has stopped all work for now: Test stop');
      w.stop();
    }
  });

  it('a stuck request times out and, after 60 seconds without a good read, new work may not start', async () => {
    let hang = false;
    const w = new KillSwitchWatcher({
      fetchFeed: (signal) => (hang ? new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')))) : Promise.resolve({ items: [], keys: [PUB] })),
      pinnedKeys: null,
      onChange: () => undefined,
    });
    expect(w.startBlock()).toMatch(/Waiting to check/);
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.startBlock()).toBeNull();
    hang = true;
    await vi.advanceTimersByTimeAsync(KILL_BOUND_MS + 1);
    expect(w.fresh()).toBe(false);
    expect(w.startBlock()).toMatch(/Waiting to check/);
    expect(w.view().status).toBe('unchecked');
    hang = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(w.startBlock()).toBeNull();
    w.stop();
  });

  it('ignores entries that are unsigned, signed by an unknown key, or not pinned; a restore lifts a stop', async () => {
    const other = { keyId: 'revocation-test', privateKey: generateKeyPairSync('ed25519').privateKey };
    const items: RevocationEntry[] = [
      { ...entry({ target: 'platform', at: Date.now() - 5000 }), signature: null },
      entry({ target: 'platform', at: Date.now() - 4000, key: other }),
      { ...entry({ target: 'swarm', id: 'challenge-vaults', at: Date.now() - 3000 }), signedPayload: revocationCanonical({ revocation_version: 1, id: '00000000-0000-7000-8000-0000000000ff', target_type: 'swarm', target_id: 'challenge-vaults', action: 'revoke', reason: 'edited', severity: 'critical', effective_at: new Date().toISOString() }) },
    ];
    const { w, changes } = watcher(() => ({ items, keys: [PUB] }));
    await w.check();
    expect(changes).toEqual([]);
    expect(w.view()).toMatchObject({ status: 'ok', global: null, swarms: [] });

    items.push(entry({ target: 'swarm', id: 'prompt-guard-red-team', at: Date.now() - 2000, reason: 'Harness under review' }));
    await w.check();
    expect(w.stoppedReason('prompt-guard-red-team')).toBe('Verafy has stopped work for prompt-guard-red-team: Harness under review');
    expect(w.stoppedReason('challenge-vaults')).toBeNull();
    expect(w.stoppedReason()).toBeNull();
    expect(w.view(['challenge-vaults']).status).toBe('ok');
    expect(w.stoppedSwarms()).toEqual(['prompt-guard-red-team']);

    items.push(entry({ target: 'swarm', id: 'prompt-guard-red-team', action: 'restore', at: Date.now() - 1000 }));
    await w.check();
    expect(w.stoppedReason('prompt-guard-red-team')).toBeNull();
    expect(changes).toHaveLength(2);

    // A build with pinned keys ignores a valid entry signed by any other key, even one the feed lists.
    const pinned = watcher(() => ({ items: [entry({ target: 'platform', at: Date.now() })], keys: [PUB] }), [{ ...PUB, key_id: 'another' }]);
    await pinned.w.check();
    expect(pinned.w.stoppedReason()).toBeNull();
  });

  it('parses pinned keys from the build', () => {
    expect(parsePinnedKeys(undefined)).toBeNull();
    expect(parsePinnedKeys('')).toBeNull();
    expect(parsePinnedKeys(`a=${PUB.public_key}, b=${PUB.public_key}`)).toEqual([
      { key_id: 'a', public_key: PUB.public_key, status: 'active' },
      { key_id: 'b', public_key: PUB.public_key, status: 'active' },
    ]);
  });
});
