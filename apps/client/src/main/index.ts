import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, Menu, Tray, app, crashReporter, nativeImage, nativeTheme, protocol, session, shell } from 'electron';
import { IPC } from '../shared/bridge';
import type { Route } from '../shared/routes';
import { AuthManager } from './auth';
import { EncryptedCache } from './cache';
import { API_BASE_URL, CHANNEL, DEV_SERVER, KEYCHAIN_SERVICE, isDev } from './config';
import { SCHEME, deepLinkFromArgv, parseDeepLink } from './deeplinks';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { revocationKeys } from './config';
import { NodeController } from './node';
import { TRAY_ICON_1X, TRAY_ICON_2X } from './tray-icon';
import { KeyringStore } from './secrets';
import { APP_ORIGIN, APP_SCHEME, SECURE_WEB_PREFERENCES, contentSecurityPolicy, isAllowedExternal, isAppUrl, resolveAppFile } from './security';

const RENDERER_ROOT = path.join(__dirname, '../renderer');
const CSP = contentSecurityPolicy(API_BASE_URL, isDev);

// Local crash dumps only. Uploading (Sentry, opt in) needs a DSN and lands later.
crashReporter.start({ uploadToServer: false });

// Must run before `ready`: the app scheme gets a stable secure origin for CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Registering the scheme from an unpackaged run would point the OS at the bare
// Electron binary, so dev runs only do it when asked.
if (app.isPackaged || process.env['SWARM_EXPLORER_REGISTER_PROTOCOL'] === '1') {
  app.setAsDefaultProtocolClient(SCHEME);
}

const secrets = new KeyringStore(KEYCHAIN_SERVICE);
const auth = new AuthManager({
  apiBaseUrl: API_BASE_URL,
  secrets,
  device: { platform: process.platform, arch: process.arch, version: app.getVersion(), channel: CHANNEL },
  // Sign in always happens in the system browser, never in an app window (RFC 8252).
  openBrowser: (url) => shell.openExternal(url),
});
let cache: EncryptedCache | null = null;
let node: NodeController | null = null;
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let launchRoute: Route | null = null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function serveApp() {
  protocol.handle(APP_SCHEME, async (req) => {
    const file = resolveAppFile(RENDERER_ROOT, req.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function lockDownSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  if (isDev) {
    ses.webRequest.onHeadersReceived((details, cb) => {
      const headers = { ...details.responseHeaders };
      if (DEV_SERVER && details.url.startsWith(DEV_SERVER)) headers['Content-Security-Policy'] = [CSP];
      cb({ responseHeaders: headers });
    });
  }
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => {
    if (!isAppUrl(url, DEV_SERVER)) ev.preventDefault();
  });
  contents.on('will-redirect', (ev, url) => {
    if (!isAppUrl(url, DEV_SERVER)) ev.preventDefault();
  });
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

function send(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/** Every deep link enters here. Navigation only; writes always need a confirm in the UI. */
function openDeepLink(raw: string) {
  const parsed = parseDeepLink(raw);
  if (!parsed) {
    send(IPC.notice, 'That link is not supported, so it was ignored.');
    return;
  }
  focusWindow();
  if (parsed.kind === 'auth-callback') {
    auth.handleCallbackUrl(parsed.url);
  } else if (mainWindow && rendererReady) {
    send(IPC.navigate, parsed.route);
  } else {
    launchRoute = parsed.route;
  }
}

let rendererReady = false;

function createMainWindow(): BrowserWindow {
  const mac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Henge',
    backgroundColor: '#050506',
    ...(mac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 11 } } : {}),
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: path.join(__dirname, '../preload/index.cjs') },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
  });
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  void win.loadURL(isDev && DEV_SERVER ? DEV_SERVER : `${APP_ORIGIN}/index.html`);
  return win;
}

// macOS delivers links here, possibly before ready.
app.on('open-url', (ev, url) => {
  ev.preventDefault();
  if (app.isReady()) openDeepLink(url);
  else launchRoute = (parseDeepLink(url) as { kind: string; route?: Route } | null)?.route ?? null;
});

// Windows and Linux deliver links to the running instance as argv.
app.on('second-instance', (_e, argv) => {
  focusWindow();
  const link = deepLinkFromArgv(argv);
  if (link) openDeepLink(link);
});

auth.on('changed', (s) => {
  send(IPC.authChanged, s);
  // Registers the install and node and reports capabilities (SPEC 13.1).
  if (s.status === 'signed_in') void node?.report();
  else if (s.status === 'signed_out') {
    node?.tasks.onSignedOut();
    node?.memberships.stopAll('Signed out. Sign in to continue.');
  }
});

/** Menu bar and tray Pause stay reachable at all times (SPEC 4.1). */
function refreshPauseControls() {
  const paused = node?.isPaused ?? false;
  Menu.setApplicationMenu(buildMenu({ navigate: (r) => send(IPC.navigate, r), isDev, paused, setPaused: (p) => node?.setPaused(p) }));
  if (!tray) return;
  const running = node?.tasks.overview().current ?? null;
  tray.setToolTip(paused ? 'Henge: paused' : running ? `Henge: running a task for ${running.swarm}` : 'Henge');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: paused ? 'Resume node' : 'Pause node', click: () => node?.setPaused(!paused) },
      { type: 'separator' },
      { label: 'Open Henge', click: () => (mainWindow ? focusWindow() : (mainWindow = createMainWindow())) },
      { label: 'Quit', role: 'quit' },
    ]),
  );
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_1X);
  icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
}

void app.whenReady().then(async () => {
  // Henge is dark only (Henge SPEC 9.1): native menus, scrollbars and dialogs follow.
  nativeTheme.themeSource = 'dark';
  serveApp();
  lockDownSession();
  cache = await EncryptedCache.open(path.join(app.getPath('userData'), 'cache.db'), secrets);
  node = new NodeController({
    auth,
    cache: () => cache!,
    apiBaseUrl: API_BASE_URL,
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    channel: CHANNEL,
    revocationKeys: revocationKeys(),
    // Fixture hardware and a stand-in Ollama are test hooks for unpackaged runs only (SPEC 16.4 M1).
    testHooks: app.isPackaged
      ? null
      : { hardwareFixture: process.env['SWARM_EXPLORER_HARDWARE_FIXTURE'] || undefined, ollamaHost: process.env['SWARM_EXPLORER_OLLAMA_HOST'] || undefined, hfBase: process.env['SWARM_EXPLORER_HF_BASE'] || undefined, sensorFixture: process.env['SWARM_EXPLORER_SENSOR_FIXTURE'] || undefined },
  });
  node.on('changed', () => {
    send(IPC.nodeChanged, node!.overview());
    refreshPauseControls();
  });
  node.start();
  registerIpc({
    auth,
    node: () => node!,
    cache: () => cache!,
    takeLaunchRoute: () => {
      const r = launchRoute;
      launchRoute = null;
      return r;
    },
  });
  await auth.init();
  createTray();
  refreshPauseControls();
  void node.detect();

  const initial = deepLinkFromArgv(process.argv);
  if (initial) {
    const parsed = parseDeepLink(initial);
    if (parsed?.kind === 'navigate') launchRoute = parsed.route;
  }
  mainWindow = createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  node?.stop();
  cache?.close();
});
