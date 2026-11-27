import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Channel } from '../shared/bridge';
import type { PlatformPublicKey } from '@swarm-explorer/schema/node';
import { parsePinnedKeys } from './kill-switch';
import { DEFAULT_KEYCHAIN_SERVICE } from './secrets';

export const DEV_SERVER = process.env['ELECTRON_RENDERER_URL'] || undefined;
export const isDev = !app.isPackaged && Boolean(DEV_SERVER);

/**
 * Runtime override (unpackaged only), then the build-time value, then localhost. No production
 * API host is approved yet (SPEC 2), so there is no hosted default: local packages bake localhost.
 */
export const API_BASE_URL =
  (!app.isPackaged && process.env['SWARM_EXPLORER_API_URL']) ||
  (import.meta.env['MAIN_VITE_API_URL'] as string | undefined) ||
  'http://localhost:3000';

/**
 * HENGE_COMMUNITY_LAYOUT (spin-out spec v2, 14): the four-column Henge layout. On by default in
 * unpackaged dev and test runs; packaged builds turn it on with MAIN_VITE_HENGE_COMMUNITY_LAYOUT=1.
 * Unpackaged runs may set HENGE_COMMUNITY_LAYOUT=0 to get the v1 page set back.
 */
export const COMMUNITY_LAYOUT = app.isPackaged
  ? import.meta.env['MAIN_VITE_HENGE_COMMUNITY_LAYOUT'] === '1'
  : (process.env['HENGE_COMMUNITY_LAYOUT'] ?? (import.meta.env['MAIN_VITE_HENGE_COMMUNITY_LAYOUT'] as string | undefined) ?? '1') !== '0';

/** Packaged builds are test-signed internal builds until Beta exists (SPEC 15.1). Unpackaged runs are "dev". */
export const CHANNEL: Channel = app.isPackaged ? 'internal' : 'dev';

/**
 * Unpackaged runs use their own keychain service so a dev build never shares a session with an
 * installed one (and macOS never prompts, since each binary reads only items it created). Tests
 * pass SWARM_EXPLORER_KEYCHAIN_SERVICE for a throwaway service. Packaged builds ignore both.
 */
export const KEYCHAIN_SERVICE = app.isPackaged
  ? DEFAULT_KEYCHAIN_SERVICE
  : process.env['SWARM_EXPLORER_KEYCHAIN_SERVICE'] || `${DEFAULT_KEYCHAIN_SERVICE}.dev`;

/**
 * The release public key. Packaged builds get it at build time
 * (MAIN_VITE_RELEASE_PUBKEY). Unpackaged runs read the per-machine TEST key
 * created by `pnpm --filter @swarm-explorer/client release:test`.
 */
export function releasePublicKey(): string | null {
  const built = import.meta.env['MAIN_VITE_RELEASE_PUBKEY'] as string | undefined;
  if (built) return built;
  if (app.isPackaged) return null;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const f = path.join(dir, '.data', 'release-test', 'public.txt');
    if (existsSync(f)) return readFileSync(f, 'utf8').trim();
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Revocation feed keys (kill switch, M7), pinned at build time as MAIN_VITE_REVOCATION_PUBKEYS
 * (`key_id=spki_base64url,...`). No production key exists yet (Needs Rex), so a build without the
 * variable trusts the keys the feed lists over its own connection: signatures are still checked, but
 * the trust root is the API host. Internal test builds only.
 */
export function revocationKeys(): PlatformPublicKey[] | null {
  return parsePinnedKeys(import.meta.env['MAIN_VITE_REVOCATION_PUBKEYS'] as string | undefined);
}
