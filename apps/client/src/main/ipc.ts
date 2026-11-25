import { randomUUID } from 'node:crypto';
import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { installListSchema, meSchema } from '@swarm-explorer/api-client';
import { z } from 'zod';
import { IPC, type Account, type AppInfo, type Install } from '../shared/bridge';
import type { Route } from '../shared/routes';
import { AuthError, type AuthManager } from './auth';
import type { EncryptedCache } from './cache';
import type { NodeController } from './node';
import { modelInstallInputSchema, nodeSetupInputSchema, type ModelActionResult } from '../shared/node';
import { API_BASE_URL, CHANNEL, DEV_SERVER, releasePublicKey } from './config';
import { isAllowedExternal, isAppUrl } from './security';
import { checkForUpdates } from './updates';

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

  const refusedModel: ModelActionResult = { ok: false, code: 'refused', message: 'That request was refused.' };
  const hash = z.string().regex(/^sha256-[a-f0-9]{64}$/);
  handle(IPC.modelsInstall, modelInstallInputSchema, (i) => deps.node().models.install(i), refusedModel);
  handle(IPC.modelsBenchmark, hash, (h) => deps.node().models.benchmark(h), refusedModel);
  handle(IPC.modelsRemove, hash, (h) => deps.node().models.remove(h), refusedModel);
  handle(IPC.modelsSetActive, hash, (h) => deps.node().models.setActive(h), refusedModel);
  handle(IPC.modelsSetBudget, z.number().int().positive().max(2 ** 50), (b) => deps.node().models.setDiskBudget(b), refusedModel);

  handle(IPC.launchRoute, none, () => deps.takeLaunchRoute(), null);
}
