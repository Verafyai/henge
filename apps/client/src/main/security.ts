/**
 * Electron hardening (ADDENDUM A4.1, A8.2). Pure helpers live here so they can
 * be unit tested without launching Electron.
 */
import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'henge';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Every privileged window uses exactly these. A test asserts them on each live window. */
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: false,
  navigateOnDragDrop: false,
} as const;

/** Hosts the system browser may be sent to. Everything else is refused. */
export const EXTERNAL_HOSTS = new Set(['www.verafy.ai', 'github.com']);

export function isAllowedExternal(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.username === '' && u.password === '' && EXTERNAL_HOSTS.has(u.hostname);
}

/** In-window navigation is allowed only within the app's own origin (or the Vite dev server). */
export function isAppUrl(raw: string, devServerUrl?: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST) return true;
  if (devServerUrl) {
    try {
      return u.origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

export function contentSecurityPolicy(apiBaseUrl: string, dev = false): string {
  const api = new URL(apiBaseUrl).origin;
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // React style props (mask gradients, progress widths) need inline styles; scripts stay strict.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', api],
    'font-src': ["'self'", 'data:'],
    'connect-src': dev ? ["'self'", api, 'ws:'] : ["'self'", api],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],
    'worker-src': ["'self'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

/**
 * Maps an app:// request to a file under `root`, refusing anything that would
 * escape it. Returns null for traversal attempts.
 */
export function resolveAppFile(root: string, requestUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  if (u.host !== APP_HOST) return null;
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  const full = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  return full.startsWith(base) ? full : null;
}
