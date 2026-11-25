/**
 * The only surface the renderer can reach in the main process (SPEC 11.1):
 * named, typed methods. No generic invoke, no filesystem, no Node globals.
 * Tokens never cross this bridge; the main process makes authenticated calls.
 */
import type { JoinStarted, SwarmDetail } from '@swarm-explorer/api-client';
import type { MembershipResult, MembershipsOverview, ModelActionResult, ModelInstallInput, NodeOverview, NodeSetup, Permissions, SandboxCheck } from './node';
import type { Route } from './routes';

export type Channel = 'stable' | 'beta' | 'internal' | 'dev';

export type AppInfo = {
  version: string;
  platform: 'darwin' | 'win32' | 'linux' | string;
  arch: string;
  channel: Channel;
  apiBaseUrl: string;
  isPackaged: boolean;
};

export type AuthState = { status: 'signed_out' | 'signing_in' | 'signed_in'; error?: string };

export type Account = { id: string; handle: string; displayName: string; installId: string };

export type Install = {
  id: string;
  platform: string;
  arch: string;
  version: string;
  channel: Channel;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  current: boolean;
};

export type UpdateStatus =
  | { kind: 'available'; version: string; channel: string; notes: string; message: string }
  | { kind: 'none' | 'rejected' | 'error' | 'unavailable'; message: string };

export interface SwarmBridge {
  getAppInfo(): Promise<AppInfo>;
  /** Opens an allowlisted https URL in the system browser. Resolves false when refused. */
  openExternal(url: string): Promise<boolean>;
  auth: {
    getState(): Promise<AuthState>;
    signIn(): Promise<AuthState>;
    signOut(): Promise<AuthState>;
    onChanged(cb: (s: AuthState) => void): () => void;
  };
  account: {
    /** Null when signed out or offline. */
    me(): Promise<Account | null>;
    installs(): Promise<Install[] | null>;
    revokeInstall(id: string): Promise<boolean>;
  };
  /** Recently viewed swarms, kept in the encrypted local cache. */
  recent: {
    list(): Promise<string[]>;
    add(slug: string): Promise<string[]>;
  };
  updates: { check(): Promise<UpdateStatus> };
  /** Node shell (SPEC 5.1). Hardware facts and choices only; no keys or tokens ever cross. */
  node: {
    overview(): Promise<NodeOverview>;
    detect(): Promise<NodeOverview>;
    saveSetup(s: Omit<NodeSetup, 'completedAt'>): Promise<NodeOverview | null>;
    resetSetup(): Promise<NodeOverview>;
    setPaused(paused: boolean): Promise<NodeOverview>;
    onChanged(cb: (o: NodeOverview) => void): () => void;
    /** Runs the sandbox self-checks (SPEC 16.4 M3) on this computer. */
    sandboxCheck(): Promise<SandboxCheck[]>;
  };
  /** Model downloads (SPEC 5.4). Main re-checks catalog, license, disk budget and fit for every call. */
  models: {
    install(i: ModelInstallInput): Promise<ModelActionResult>;
    benchmark(contentHash: string): Promise<ModelActionResult>;
    remove(contentHash: string): Promise<ModelActionResult>;
    setActive(contentHash: string): Promise<ModelActionResult>;
    setDiskBudget(bytes: number): Promise<ModelActionResult>;
  };
  /**
   * Your swarms (SPEC 13.2). Main re-checks everything with the server. Approval names a hash the
   * app itself showed for review, so the renderer cannot approve permissions nobody saw.
   */
  swarms: {
    refresh(): Promise<MembershipsOverview>;
    startJoin(slug: string): Promise<MembershipResult<{ join: JoinStarted; swarm: SwarmDetail }>>;
    reviewChange(membershipId: string): Promise<MembershipResult<{ swarm: SwarmDetail; previous: Permissions | null }>>;
    approve(membershipId: string, permissionsHash: string): Promise<MembershipResult>;
    retry(membershipId: string): Promise<MembershipResult>;
    leave(membershipId: string): Promise<MembershipResult<{ abandonedLeases: number }>>;
  };
  /** Deep links and menu commands. Navigation only, never a write. */
  onNavigate(cb: (route: Route) => void): () => void;
  /** A deep link that launched the app before the UI was listening, consumed once. */
  takeLaunchRoute(): Promise<Route | null>;
  /** Short messages for the user, for example an ignored deep link. */
  onNotice(cb: (message: string) => void): () => void;
}

/** IPC channel names. Kept in one place so main and preload cannot drift. */
export const IPC = {
  appInfo: 'app:info',
  openExternal: 'shell:open-external',
  authState: 'auth:state',
  authSignIn: 'auth:sign-in',
  authSignOut: 'auth:sign-out',
  authChanged: 'auth:changed',
  me: 'account:me',
  installs: 'account:installs',
  revokeInstall: 'account:revoke-install',
  recentList: 'recent:list',
  recentAdd: 'recent:add',
  updatesCheck: 'updates:check',
  nodeOverview: 'node:overview',
  nodeDetect: 'node:detect',
  nodeSaveSetup: 'node:save-setup',
  nodeResetSetup: 'node:reset-setup',
  nodeSetPaused: 'node:set-paused',
  nodeChanged: 'node:changed',
  nodeSandboxCheck: 'node:sandbox-check',
  modelsInstall: 'models:install',
  modelsBenchmark: 'models:benchmark',
  modelsRemove: 'models:remove',
  modelsSetActive: 'models:set-active',
  modelsSetBudget: 'models:set-budget',
  swarmsRefresh: 'swarms:refresh',
  swarmsStartJoin: 'swarms:start-join',
  swarmsReviewChange: 'swarms:review-change',
  swarmsApprove: 'swarms:approve',
  swarmsRetry: 'swarms:retry',
  swarmsLeave: 'swarms:leave',
  navigate: 'nav:navigate',
  launchRoute: 'nav:launch-route',
  notice: 'nav:notice',
} as const;

declare global {
  interface Window {
    swarm: SwarmBridge;
  }
}
