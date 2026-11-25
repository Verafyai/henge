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
  },
  recent: {
    list: () => invoke(IPC.recentList),
    add: (slug) => invoke(IPC.recentAdd, String(slug)),
  },
  updates: { check: () => invoke(IPC.updatesCheck) },
  node: {
    overview: () => invoke(IPC.nodeOverview),
    detect: () => invoke(IPC.nodeDetect),
    saveSetup: (s) => invoke(IPC.nodeSaveSetup, s),
    resetSetup: () => invoke(IPC.nodeResetSetup),
    setPaused: (p) => invoke(IPC.nodeSetPaused, Boolean(p)),
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
  onNavigate: (cb) => on<Route>(IPC.navigate, cb),
  takeLaunchRoute: () => invoke(IPC.launchRoute),
  onNotice: (cb) => on<string>(IPC.notice, cb),
};

// contextBridge hands the page read-only proxies of these functions.
contextBridge.exposeInMainWorld('swarm', bridge);
