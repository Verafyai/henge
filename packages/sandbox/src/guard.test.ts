import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintCapability, newCapabilityKey } from './capability';
import { guardModelCall, ModelProxy, proxyComplete, type ModelCallGuard } from './proxy';
import type { CompletionSource } from './sources';

const H = (c: string) => `sha256-${c.repeat(64)}`;
const ask = { messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 4 };
const dir = mkdtempSync(path.join(tmpdir(), 'se-guard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: ModelCallGuard = { paused: false, scheduleOk: true, capUsdMicros: null, spentUsdMicros: 0, day: '2026-11-26' };

describe('model call guard (spin-out 9.3)', () => {
  it('pause stops every call, run rules stop task calls only, the cap stops any call at or over it', () => {
    expect(guardModelCall(null, 'lease-1')).toBeNull();
    expect(guardModelCall(open, 'lease-1')).toBeNull();
    expect(guardModelCall({ ...open, paused: true }, 'lease-1')).toBe('node_paused');
    expect(guardModelCall({ ...open, paused: true }, 'qualification:m')).toBe('node_paused');
    expect(guardModelCall({ ...open, scheduleOk: false }, 'lease-1')).toBe('outside_run_rules');
    expect(guardModelCall({ ...open, scheduleOk: false }, 'qualification:m')).toBeNull();
    expect(guardModelCall({ ...open, capUsdMicros: 10_000, spentUsdMicros: 9_999 }, 'lease-1')).toBeNull();
    expect(guardModelCall({ ...open, capUsdMicros: 10_000, spentUsdMicros: 10_000 }, 'lease-1')).toBe('daily_cap_reached');
    expect(guardModelCall({ ...open, paused: true, capUsdMicros: 0 }, 'self-check')).toBeNull();
  });

  it('checks before every call and counts reported cost at once, so a $0.01 cap allows exactly one one-cent call', async () => {
    const key = newCapabilityKey();
    const sock = path.join(dir, 'g.sock');
    let runtimeCalls = 0;
    const src: CompletionSource = {
      complete: async () => {
        runtimeCalls++;
        return { content: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, cost_usd_micros: 10_000 };
      },
    };
    const spend: number[] = [];
    const refused: string[] = [];
    const proxy = new ModelProxy({ key, socketPath: sock, ollamaBase: null, sources: { ollama: src }, onSpend: (e) => spend.push(e.usdMicros), onRefused: (e) => refused.push(e.code) });
    await proxy.start();
    await proxy.setModels([{ contentHash: H('a'), runtime: 'ollama', ref: 'm' }]);
    proxy.setGuard({ ...open, capUsdMicros: 10_000 });
    const cap = mintCapability(key, { lease: 'lease-1', model: H('a'), model_class: 'c', max_tokens: 100, max_cost_usd_micros: 0, permissions_hash: H('d') }, 60_000);
    expect(await proxyComplete(sock, cap, ask)).toMatchObject({ status: 200 });
    // Main has not caught up (it still says 0 spent): the proxy keeps its own count for the day.
    proxy.setGuard({ ...open, capUsdMicros: 10_000, spentUsdMicros: 0 });
    expect(await proxyComplete(sock, cap, ask)).toMatchObject({ status: 402, body: { error: 'daily_cap_reached' } });
    expect(runtimeCalls).toBe(1);
    expect(spend).toEqual([10_000]);
    expect(refused).toEqual(['daily_cap_reached']);
    // A new day starts from main's figure.
    proxy.setGuard({ ...open, day: '2026-11-27', capUsdMicros: 10_000, spentUsdMicros: 0 });
    expect(await proxyComplete(sock, cap, ask)).toMatchObject({ status: 200 });
    proxy.setGuard({ ...open, day: '2026-11-27', paused: true });
    expect(await proxyComplete(sock, cap, ask)).toMatchObject({ status: 423, body: { error: 'node_paused' } });
    expect(runtimeCalls).toBe(2);
    await proxy.stop();
  });
});
