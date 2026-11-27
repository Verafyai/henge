import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type SwarmBridge } from '../shared/bridge';
import type { Route } from '../shared/routes';

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

/** Subscribes to a main-process event; the renderer never sees the IPC event object. */
function on<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: SwarmBridge = {
  getAppInfo: () => invoke(IPC.appInfo),
  openExternal: (url) => invoke(IPC.openExternal, String(url)),
  auth: {
    getState: () => invoke(IPC.authState),
    signIn: () => invoke(IPC.authSignIn),
    signOut: () => invoke(IPC.authSignOut),
    onChanged: (cb) => on(IPC.authChanged, cb),
  },
  account: {
    me: () => invoke(IPC.me),
    installs: () => invoke(IPC.installs),
    revokeInstall: (id) => invoke(IPC.revokeInstall, String(id)),
    wallet: () => invoke(IPC.wallet),
    results: () => invoke(IPC.results),
    receipt: (id) => invoke(IPC.receipt, String(id)),
    saveReceipt: (id) => invoke(IPC.saveReceipt, String(id)),
  },
  recent: {
    list: () => invoke(IPC.recentList),
    add: (slug) => invoke(IPC.recentAdd, String(slug)),
  },
  updates: { check: () => invoke(IPC.updatesCheck), download: () => invoke(IPC.updatesDownload) },
  node: {
    overview: () => invoke(IPC.nodeOverview),
    detect: () => invoke(IPC.nodeDetect),
    saveSetup: (s) => invoke(IPC.nodeSaveSetup, s),
    resetSetup: () => invoke(IPC.nodeResetSetup),
    setPaused: (p) => invoke(IPC.nodeSetPaused, Boolean(p)),
    setRunRules: (r) => invoke(IPC.nodeSetRunRules, r),
    onChanged: (cb) => on(IPC.nodeChanged, cb),
    sandboxCheck: () => invoke(IPC.nodeSandboxCheck),
  },
  models: {
    install: (i) => invoke(IPC.modelsInstall, i),
    benchmark: (h) => invoke(IPC.modelsBenchmark, h),
    remove: (h) => invoke(IPC.modelsRemove, h),
    setActive: (h) => invoke(IPC.modelsSetActive, h),
    setDiskBudget: (b) => invoke(IPC.modelsSetBudget, b),
  },
  swarms: {
    refresh: () => invoke(IPC.swarmsRefresh),
    startJoin: (slug) => invoke(IPC.swarmsStartJoin, String(slug)),
    reviewChange: (id) => invoke(IPC.swarmsReviewChange, String(id)),
    approve: (id, hash) => invoke(IPC.swarmsApprove, { membershipId: String(id), permissionsHash: String(hash) }),
    retry: (id) => invoke(IPC.swarmsRetry, String(id)),
    leave: (id) => invoke(IPC.swarmsLeave, String(id)),
    setShares: (s) => invoke(IPC.swarmsSetShares, s),
    equalize: () => invoke(IPC.swarmsEqualize),
    keepShares: () => invoke(IPC.swarmsKeepShares),
  },
  henges: {
    list: () => invoke(IPC.hengesList),
    resolve: (link) => invoke(IPC.hengesResolve, String(link)),
    join: (i) => invoke(IPC.hengesJoin, i),
    create: (i) => invoke(IPC.hengesCreate, i),
    leave: (key) => invoke(IPC.hengesLeave, String(key)),
    source: (key) => invoke(IPC.hengesSource, String(key)),
    glyphCatalog: () => invoke(IPC.hengesGlyphCatalog),
    planGlyphAdd: (i) => invoke(IPC.hengesPlanGlyphAdd, i),
    addGlyph: (i) => invoke(IPC.hengesAddGlyph, i),
    planRunes: (i) => invoke(IPC.hengesPlanRunes, i),
    applyRunes: (i) => invoke(IPC.hengesApplyRunes, i),
  },
  onNavigate: (cb) => on<Route>(IPC.navigate, cb),
  takeLaunchRoute: () => invoke(IPC.launchRoute),
  onNotice: (cb) => on<string>(IPC.notice, cb),
};

// contextBridge hands the page read-only proxies of these functions.
contextBridge.exposeInMainWorld('swarm', bridge);
