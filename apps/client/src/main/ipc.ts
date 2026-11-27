import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { createApiClient, installListSchema, meSchema, receiptEnvelopeSchema, resultListSchema, walletSchema, type ResultItem, type Wallet } from '@swarm-explorer/api-client';
import { verifyReceipt } from '@swarm-explorer/schema/node';
import { z } from 'zod';
import { IPC, type Account, type AppInfo, type Install, type ReceiptView } from '../shared/bridge';
import type { Route } from '../shared/routes';
import { AuthError, type AuthManager } from './auth';
import type { EncryptedCache } from './cache';
import type { NodeController } from './node';
import { parseUsd, runRulesSchema } from '@swarm-explorer/node-core';
import { modelInstallInputSchema, nodeSetupInputSchema, type MembershipResult, type ModelActionResult } from '../shared/node';
import { API_BASE_URL, CHANNEL, DEV_SERVER, releasePublicKey } from './config';
import { isAllowedExternal, isAppUrl } from './security';
import { checkForUpdates, downloadUpdate, mirrorBase } from './updates';

/** Rejects IPC from anything other than our own top level app frame. */
function trusted(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url;
  return Boolean(url) && e.senderFrame === e.sender.mainFrame && isAppUrl(url!, DEV_SERVER);
}

/** Registers a handler that only runs for trusted senders with valid input. */
function handle<S extends z.ZodType, R>(channel: string, input: S, fn: (arg: z.output<S>) => Promise<R> | R, refused: R) {
  ipcMain.handle(channel, async (e, raw: unknown) => {
    if (!trusted(e)) return refused;
    const parsed = input.safeParse(raw);
    return parsed.success ? fn(parsed.data) : refused;
  });
}

const none = z.undefined();
const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/);

export function registerIpc(deps: { auth: AuthManager; node: () => NodeController; cache: () => EncryptedCache; takeLaunchRoute: () => Route | null }) {
  const { auth } = deps;

  handle(IPC.appInfo, none, (): AppInfo => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, channel: CHANNEL, apiBaseUrl: API_BASE_URL, isPackaged: app.isPackaged }), null);

  handle(IPC.openExternal, z.string().max(2048), async (url) => {
    if (!isAllowedExternal(url)) return false;
    await shell.openExternal(url);
    return true;
  }, false);

  handle(IPC.authState, none, () => auth.getState(), null);
  handle(IPC.authSignIn, none, async () => {
    await auth.signIn().catch(() => undefined); // The state carries the error message.
    return auth.getState();
  }, null);
  handle(IPC.authSignOut, none, async () => {
    // Return a running task to the queue while the session can still sign the abandon.
    await deps.node().tasks.drain('signed_out');
    await auth.signOut();
    return auth.getState();
  }, null);

  handle(IPC.me, none, async (): Promise<Account | null> => {
    try {
      const res = await auth.authedFetch('/v1/me');
      const parsed = meSchema.safeParse(await res.json());
      return res.ok && parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }, null);

  handle(IPC.installs, none, async (): Promise<Install[] | null> => {
    try {
      const res = await auth.authedFetch('/v1/me/installs');
      const parsed = installListSchema.safeParse(await res.json());
      return res.ok && parsed.success ? parsed.data.items : null;
    } catch {
      return null;
    }
  }, null);

  handle(IPC.wallet, none, async (): Promise<Wallet | null> => {
    try {
      const res = await auth.authedFetch('/v1/wallet');
      const parsed = walletSchema.safeParse(await res.json());
      return res.ok && parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }, null);

  handle(IPC.results, none, async (): Promise<ResultItem[] | null> => {
    try {
      const res = await auth.authedFetch('/v1/me/results');
      const parsed = resultListSchema.safeParse(await res.json());
      return res.ok && parsed.success ? parsed.data.items : null;
    } catch {
      return null;
    }
  }, null);

  /** Fetches a receipt and checks it here against the platform's published receipt keys. */
  const fetchReceipt = async (id: string) => {
    const res = await auth.authedFetch(`/v1/me/results/${id}/receipt`);
    const parsed = receiptEnvelopeSchema.safeParse(await res.json());
    if (!res.ok || !parsed.success) return null;
    const keys = await createApiClient({ baseUrl: API_BASE_URL }).receiptKeys().then((k) => k.keys).catch(() => undefined);
    return { raw: parsed.data.receipt, check: verifyReceipt(parsed.data.receipt, keys) };
  };

  handle(IPC.receipt, z.uuid(), async (id): Promise<ReceiptView | null> => {
    try {
      const r = await fetchReceipt(id);
      if (!r) return null;
      if (!r.check.ok) return { receipt: r.raw as unknown as ReceiptView['receipt'], verified: false, detail: `This receipt did not verify (${r.check.reason}).` };
      return {
        receipt: r.check.receipt,
        verified: r.check.keyTrusted === true,
        detail: r.check.keyTrusted ? 'Signature checked on this computer against Verafy’s published receipt key.' : 'The signature matches, but the receipt keys could not be fetched to confirm the signer.',
      };
    } catch {
      return null;
    }
  }, null);

  handle(IPC.saveReceipt, z.uuid(), async (id) => {
    try {
      const r = await fetchReceipt(id);
      if (!r) return { saved: false, path: null };
      const win = BrowserWindow.getFocusedWindow();
      const opts = { title: 'Save receipt', defaultPath: path.join(app.getPath('downloads'), `henge-receipt-${id}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] };
      const pick = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (pick.canceled || !pick.filePath) return { saved: false, path: null };
      await writeFile(pick.filePath, `${JSON.stringify(r.raw, null, 2)}\n`, { mode: 0o600 });
      return { saved: true, path: pick.filePath };
    } catch {
      return { saved: false, path: null };
    }
  }, { saved: false, path: null });

  handle(IPC.revokeInstall, z.uuid(), async (id) => {
    try {
      const res = await auth.authedFetch(`/v1/me/installs/${id}`, { method: 'DELETE', headers: { 'idempotency-key': randomUUID() } });
      // Revoking this very install means we are signed out now.
      if (res.ok && id === auth.installId) await auth.signOut();
      return res.ok;
    } catch (e) {
      if (e instanceof AuthError) return false;
      return false;
    }
  }, false);

  const recent = () => deps.cache().get<string[]>('recently-viewed') ?? [];
  handle(IPC.recentList, none, recent, []);
  handle(IPC.recentAdd, slug, (s) => {
    const next = [s, ...recent().filter((r) => r !== s)].slice(0, 5);
    deps.cache().set('recently-viewed', next);
    return next;
  }, []);

  handle(IPC.updatesCheck, none, () =>
    checkForUpdates({
      apiBaseUrl: API_BASE_URL,
      currentVersion: app.getVersion(),
      channel: CHANNEL,
      platform: process.platform,
      arch: process.arch,
      publicKey: releasePublicKey(),
      installId: auth.installId,
    }),
    null,
  );

  handle(IPC.updatesDownload, none, () =>
    downloadUpdate({
      apiBaseUrl: API_BASE_URL,
      currentVersion: app.getVersion(),
      channel: CHANNEL,
      platform: process.platform,
      arch: process.arch,
      publicKey: releasePublicKey(),
      installId: auth.installId,
      stagingDir: path.join(app.getPath('userData'), 'updates'),
      // Test hook for unpackaged runs only: a local mirror of the pinned test release host.
      mirror: app.isPackaged ? null : mirrorBase(process.env['SWARM_EXPLORER_RELEASE_MIRROR']),
    }),
    { kind: 'error', message: 'The update could not be downloaded.' },
  );

  handle(IPC.nodeOverview, none, () => deps.node().overview(), null);
  handle(IPC.nodeSandboxCheck, none, () => deps.node().sandboxCheck(), []);
  handle(IPC.nodeDetect, none, async () => {
    await deps.node().detect(true);
    return deps.node().overview();
  }, null);
  // API and Hybrid stay unavailable until a provider clears the terms review (SPEC 5.5).
  handle(IPC.nodeSaveSetup, nodeSetupInputSchema, (s) => {
    const o = deps.node().overview();
    if (!o.recommendation?.options.find((m) => m.mode === s.mode)?.available) return null;
    deps.node().saveSetup(s);
    return deps.node().overview();
  }, null);
  handle(IPC.nodeResetSetup, none, () => {
    deps.node().clearSetup();
    return deps.node().overview();
  }, null);
  handle(IPC.nodeSetPaused, z.boolean(), (p) => {
    deps.node().setPaused(p);
    return deps.node().overview();
  }, null);
  handle(IPC.nodeSetRunRules, runRulesSchema, (r) => {
    deps.node().setRunRules(r);
    return deps.node().overview();
  }, null);
  // The member's daily cap in dollars as typed ("0.50"), or null to clear it (spin-out 6.4).
  handle(IPC.nodeSetDailyCap, z.string().max(20).nullable(), (usd) => {
    let micros: number | null;
    try {
      micros = usd === null ? null : parseUsd(usd);
    } catch {
      return null;
    }
    deps.node().setDailyCap(micros);
    return deps.node().overview();
  }, null);
  handle(IPC.nodeJoinHenge, z.object({ url: z.string().url().max(2048), dailyCapUsd: z.string().max(20).nullable() }).strict(), async ({ url, dailyCapUsd }) => {
    let cap: number | null;
    try {
      cap = dailyCapUsd === null ? null : parseUsd(dailyCapUsd);
    } catch (e) {
      return { ok: false as const, issues: [{ code: 'invalid_cap', message: e instanceof Error ? e.message : 'Enter an amount in dollars.' }] };
    }
    return deps.node().joinHenge(url, cap);
  }, { ok: false as const, issues: [{ code: 'refused', message: 'That request was refused.' }] });
  handle(IPC.nodeConfirmHengeUpdate, z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/), version: z.string().max(64) }).strict(), async ({ id, version }) => {
    await deps.node().confirmHengeUpdate(id, version);
    return deps.node().overview();
  }, null);

  const refusedModel: ModelActionResult = { ok: false, code: 'refused', message: 'That request was refused.' };
  const hash = z.string().regex(/^sha256-[a-f0-9]{64}$/);
  handle(IPC.modelsInstall, modelInstallInputSchema, (i) => deps.node().models.install(i), refusedModel);
  handle(IPC.modelsBenchmark, hash, (h) => deps.node().models.benchmark(h), refusedModel);
  handle(IPC.modelsRemove, hash, (h) => deps.node().models.remove(h), refusedModel);
  handle(IPC.modelsSetActive, hash, (h) => deps.node().models.setActive(h), refusedModel);
  handle(IPC.modelsSetBudget, z.number().int().positive().max(2 ** 50), (b) => deps.node().models.setDiskBudget(b), refusedModel);

  const refusedJoin = { ok: false as const, code: 'refused', message: 'That request was refused.' };
  const digest = z.string().regex(/^sha256-[a-f0-9]{64}$/);
  handle(IPC.swarmsRefresh, none, async () => {
    await deps.node().memberships.refresh();
    return deps.node().memberships.overview();
  }, null);
  handle(IPC.swarmsStartJoin, slug, (s) => deps.node().memberships.startJoin(s), refusedJoin);
  handle(IPC.swarmsReviewChange, z.uuid(), (id) => deps.node().memberships.reviewChange(id), refusedJoin);
  handle(IPC.swarmsApprove, z.object({ membershipId: z.uuid(), permissionsHash: digest }).strict(), (a) => deps.node().memberships.approve(a.membershipId, a.permissionsHash), refusedJoin);
  handle(IPC.swarmsRetry, z.uuid(), (id) => deps.node().memberships.retry(id), refusedJoin);
  handle(IPC.swarmsLeave, z.uuid(), (id) => deps.node().memberships.leave(id), refusedJoin);
  // Shares are whole basis points; the server checks they name every qualified swarm and sum to 10,000.
  handle(IPC.swarmsSetShares, z.array(z.object({ membershipId: z.uuid(), shareBp: z.number().int().min(0).max(10_000) }).strict()).min(1).max(64), (s) => deps.node().memberships.setShares(s), refusedJoin);
  handle(IPC.swarmsEqualize, none, () => deps.node().memberships.equalize(), refusedJoin);
  handle(IPC.swarmsKeepShares, none, (): MembershipResult => {
    deps.node().memberships.keepShares();
    return { ok: true };
  }, refusedJoin);

  handle(IPC.launchRoute, none, () => deps.takeLaunchRoute(), null);
}
