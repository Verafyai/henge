/**
 * Update checks (SPEC 15.1). The manifest is verified against a release
 * public key compiled into the build, then checked for channel, platform,
 * pinned host and downgrade. Installing (download, sha256, OS signature
 * check, swap) lands with packaged builds; see docs/DECISIONS.md.
 */
import { evaluateUpdate, type Manifest } from '@swarm-explorer/api-client/release';
import type { UpdateStatus } from '../shared/bridge';

/**
 * Pinned download hosts. No production release host is approved yet (SPEC 2: confirm hosting
 * before provisioning), so only the reserved .test name used by local test releases is pinned.
 */
export const RELEASE_HOSTS = ['releases.swarm-explorer.test'];

export async function checkForUpdates(opts: {
  apiBaseUrl: string;
  currentVersion: string;
  channel: 'stable' | 'beta' | 'internal' | 'dev';
  platform: string;
  arch: string;
  publicKey: string | null;
  installId: string | null;
  fetch?: typeof fetch;
}): Promise<UpdateStatus> {
  if (!opts.publicKey) return { kind: 'unavailable', message: 'This build has no release key, so updates are off.' };
  // Development builds follow the internal channel (SPEC 15.1).
  const channel = opts.channel === 'dev' ? 'internal' : opts.channel;
  const u = new URL('/v1/releases/latest', opts.apiBaseUrl);
  u.search = new URLSearchParams({ platform: opts.platform, arch: opts.arch, channel, ...(opts.installId ? { install_id: opts.installId } : {}) }).toString();
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(u, { headers: { accept: 'application/json' } });
  } catch {
    return { kind: 'error', message: 'Could not reach the update server.' };
  }
  if (res.status === 204) return { kind: 'none', message: 'You are on the latest version.' };
  if (!res.ok) return { kind: 'error', message: `Update check failed (${res.status}).` };
  const decision = evaluateUpdate(await res.json().catch(() => null), {
    currentVersion: opts.currentVersion,
    channel,
    platform: opts.platform,
    arch: opts.arch,
    publicKey: opts.publicKey,
    pinnedHosts: RELEASE_HOSTS,
  });
  if (decision.kind === 'none') return { kind: 'none', message: 'You are on the latest version.' };
  if (decision.kind === 'rejected') return { kind: 'rejected', message: `Update refused: ${decision.reason}.` };
  const m: Manifest = decision.manifest;
  return { kind: 'available', version: m.version, channel: m.channel, notes: m.notes, message: `Version ${m.version} is available (signature verified).` };
}
