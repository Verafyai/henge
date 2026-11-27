/**
 * JoinWorkflow and BundleUpdateWorkflow (spin-out spec v2, 6.4, 6.5, 9.3) on the real bundled
 * Temporal dev server: join waits for admission when the Henge reviews requests; a scheduled
 * update that changes a `member_reconsent_on` field holds the node until the member re-confirms;
 * other updates apply on their own; the check loop continues as new to keep its history short.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { parseHenge, type HengeResolveResult, type HengeV1 } from '@swarm-explorer/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EncryptedCache } from '../cache';
import { HengeStore } from '../henges';
import { createBundleActivities, createTaskActivities } from './activities';
import { CONTINUE_AS_NEW_AFTER_EVENTS } from './constants';
import { EncryptionCodec } from './codec';
import { bundleWorkflowId, TemporalEngine } from './engine';
import { TemporalDevServer, temporalBinaryPath } from './server';

const APP_ROOT = path.resolve(__dirname, '../../..');
const BINARY = temporalBinaryPath({ isPackaged: false, resourcesPath: '', appRoot: APP_ROOT });
const PORT = 17243;
const NAMESPACE = 'henge-bundle-test';
const EXAMPLE = path.resolve(APP_ROOT, '../../packages/schema/fixtures/henge/valid/example.henge.yaml');
const URL_ = 'https://example.org/resolved-forecasts.henge.yaml';

const parsed = parseHenge(readFileSync(EXAMPLE, 'utf8'));
if (!parsed.ok) throw new Error('example .henge does not validate');
const base = parsed.henge;
let served: HengeV1 = base;
let fetches = 0;
const digestOf = (h: HengeV1) => `sha256-${Buffer.from(`${h.version}`).toString('hex').padEnd(64, '0').slice(0, 64)}`;
const resolve = async (): Promise<HengeResolveResult> => {
  fetches++;
  return { ok: true, henge: served, files: new Map(), pin: { url: URL_, commit: null, etag: null, bundle_digest: digestOf(served) as `sha256-${string}`, version: served.version }, unchecked: [] };
};

const mem = new Map<string, unknown>();
const cache = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: unknown) => void mem.set(k, structuredClone(v)), delete: (k: string) => void mem.delete(k) } as unknown as EncryptedCache;
const holds: Array<string[]> = [];
const store = new HengeStore({ cache: () => cache, onHold: (h) => holds.push([...h]), resolve });

const codec = new EncryptionCodec(randomBytes(32));
let server: TemporalDevServer;
let engine: TemporalEngine;
let client: Client;
const work = mkdtempSync(path.join(tmpdir(), 'henge-bundle-'));

async function until<T>(f: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.runIf(existsSync(BINARY))('Henge join and scheduled bundle updates (spin-out 6.4, 9.3)', () => {
  beforeAll(async () => {
    server = new TemporalDevServer({ binary: BINARY, dataDir: path.join(work, 'temporal'), namespace: NAMESPACE, port: PORT, uiPort: PORT + 1000 });
    const stub = (() => {
      throw new Error('unused');
    }) as never;
    engine = new TemporalEngine({
      server,
      namespace: NAMESPACE,
      taskQueue: 'henge-node',
      workflows: { workflowsPath: path.join(__dirname, 'workflows.ts') },
      activities: {
        ...createTaskActivities({ signedFetch: stub, signWithDevice: stub, appVersion: '0', guard: stub, stopFor: stub, registerAbort: stub, runSpec: stub, run: stub, progress: stub, checkKill: stub }),
        ...createBundleActivities(store.activityDeps()),
      },
      codec,
    });
    await engine.start();
    client = new Client({ connection: await Connection.connect({ address: server.address }), namespace: NAMESPACE, dataConverter: { payloadCodecs: [codec] } });
  }, 120_000);

  afterAll(async () => {
    await engine?.stop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('refuses to join without the daily cap the file requires', async () => {
    const { result } = await engine.joinHenge({ url: URL_, dailyCapUsdMicros: null });
    expect(await result).toMatchObject({ ok: false, issues: [{ code: 'budget_daily_cap_required' }] });
    expect(store.list()).toEqual([]);
  }, 30_000);

  it('joins, waits for admission, then pins and checks for updates on a schedule', async () => {
    const { workflowId, result } = await engine.joinHenge({ url: URL_, dailyCapUsdMicros: 10_000 }, 100);
    const pin = await until(() => store.get(base.id), (p) => p !== null);
    expect(pin).toMatchObject({ id: base.id, url: URL_, version: '0.1.0', status: 'awaiting_admission', dailyCapUsdMicros: 10_000, bundleDigest: digestOf(base) });
    // The member's cap counts toward the node's daily cap.
    expect(store.caps()).toEqual([10_000]);
    await engine.admitted(workflowId);
    expect(await result).toEqual({ ok: true, id: base.id, status: 'joined' });
    expect(store.get(base.id)?.status).toBe('joined');
    const before = fetches;
    await until(() => fetches, (n) => n >= before + 3);
    expect(store.get(base.id)?.version).toBe('0.1.0');
  }, 60_000);

  it('an update to a member_reconsent_on field holds the node until the member confirms it', async () => {
    served = { ...base, version: '0.2.0', data_policy: { ...base.data_policy, retention_days: 30 } };
    const held = await until(() => store.get(base.id), (p) => p?.status === 'awaiting_reconsent');
    expect(held?.pending).toMatchObject({ version: '0.2.0', fields: ['data_policy'] });
    expect(holds.at(-1)).toEqual([base.id]);
    expect(store.heldIds().has(base.id)).toBe(true);
    // Still held while unconfirmed.
    await new Promise((r) => setTimeout(r, 500));
    expect(store.get(base.id)?.version).toBe('0.1.0');
    await engine.confirmReconsent(base.id, '0.2.0');
    const applied = await until(() => store.get(base.id), (p) => p?.version === '0.2.0');
    expect(applied).toMatchObject({ status: 'joined', pending: null, bundleDigest: digestOf(served) });
    expect(holds.at(-1)).toEqual([]);
  }, 60_000);

  it('an update that needs no re-consent applies by itself', async () => {
    served = { ...served, version: '0.3.0', summary: 'A changed summary that needs no consent.' };
    const applied = await until(() => store.get(base.id), (p) => p?.version === '0.3.0');
    expect(applied?.status).toBe('joined');
  }, 60_000);

  it('the check loop continues as new once its history passes the limit', async () => {
    const h = client.workflow.getHandle(bundleWorkflowId(base.id));
    const first = (await h.describe()).runId;
    const d = await until(() => h.describe(), (x) => x.runId !== first, 90_000);
    expect(d.status.name).toBe('RUNNING');
    expect(CONTINUE_AS_NEW_AFTER_EVENTS).toBe(400);
    await h.terminate('test done');
  }, 120_000);

  it('stores no Henge content in plain text in the local server database (payloads are encrypted)', () => {
    const dir = path.join(work, 'temporal');
    const text = readdirSync(dir)
      .filter((f) => f.startsWith('temporal.sqlite'))
      .map((f) => readFileSync(path.join(dir, f)).toString('latin1'))
      .join('');
    expect(text.length).toBeGreaterThan(0);
    for (const s of ['example-org', 'resolved-forecasts', 'example.org', 'retention_days']) expect(text).not.toContain(s);
  });
});
