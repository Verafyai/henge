/**
 * Update checks and downloads (SPEC 15.1). The manifest is verified against a release public key
 * compiled into the build, then checked for channel, platform, pinned host and downgrade. A verified
 * update can be downloaded: the bytes must match the signed size and sha256 before the file is
 * staged. Installing a staged update (OS signature check and swap) needs signed, notarized packages,
 * which are not approved yet (docs/CERTIFICATES.md), so nothing is installed.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateUpdate, verifyArtifact, type Manifest } from '@swarm-explorer/api-client/release';
import type { UpdateStatus } from '../shared/bridge';

/**
 * Pinned download hosts. No production release host is approved yet (SPEC 2: confirm hosting
 * before provisioning), so only the reserved .test name used by local test releases is pinned.
 */
export const RELEASE_HOSTS = ['releases.swarm-explorer.test'];

type CheckOpts = {
  apiBaseUrl: string;
  currentVersion: string;
  channel: 'stable' | 'beta' | 'internal' | 'dev';
  platform: string;
  arch: string;
  publicKey: string | null;
  installId: string | null;
  fetch?: typeof fetch;
};

async function verifiedManifest(opts: CheckOpts): Promise<{ status: UpdateStatus; manifest: Manifest | null }> {
  const fail = (status: UpdateStatus) => ({ status, manifest: null });
  if (!opts.publicKey) return fail({ kind: 'unavailable', message: 'This build has no release key, so updates are off.' });
  // Development builds follow the internal channel (SPEC 15.1).
  const channel = opts.channel === 'dev' ? 'internal' : opts.channel;
  const u = new URL('/v1/releases/latest', opts.apiBaseUrl);
  u.search = new URLSearchParams({ platform: opts.platform, arch: opts.arch, channel, ...(opts.installId ? { install_id: opts.installId } : {}) }).toString();
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(u, { headers: { accept: 'application/json' } });
  } catch {
    return fail({ kind: 'error', message: 'Could not reach the update server.' });
  }
  if (res.status === 204) return fail({ kind: 'none', message: 'You are on the latest version.' });
  if (!res.ok) return fail({ kind: 'error', message: `Update check failed (${res.status}).` });
  const decision = evaluateUpdate(await res.json().catch(() => null), {
    currentVersion: opts.currentVersion,
    channel,
    platform: opts.platform,
    arch: opts.arch,
    publicKey: opts.publicKey,
    pinnedHosts: RELEASE_HOSTS,
  });
  if (decision.kind === 'none') return fail({ kind: 'none', message: 'You are on the latest version.' });
  if (decision.kind === 'rejected') return fail({ kind: 'rejected', message: `Update refused: ${decision.reason}.` });
  const m: Manifest = decision.manifest;
  return { status: { kind: 'available', version: m.version, channel: m.channel, notes: m.notes, message: `Version ${m.version} is available (signature verified).` }, manifest: m };
}

export async function checkForUpdates(opts: CheckOpts): Promise<UpdateStatus> {
  return (await verifiedManifest(opts)).status;
}

/** A mirror is a local test hook only: plain http on this computer. */
export function mirrorBase(v: string | undefined | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the verified update, checks its size and sha256 against the signed manifest, and stages
 * it in `stagingDir/<version>/`. Unpackaged test runs may pass a local mirror for the pinned test
 * host; the host pin is still checked on the signed URL, and the hash check is the same.
 */
export async function downloadUpdate(opts: CheckOpts & { stagingDir: string; mirror: string | null }): Promise<UpdateStatus> {
  const { status, manifest: m } = await verifiedManifest(opts);
  if (!m) return status;
  const signed = new URL(m.url);
  const from = opts.mirror && RELEASE_HOSTS.includes(signed.hostname) ? new URL(signed.pathname, opts.mirror) : signed;
  let bytes: Uint8Array;
  try {
    const res = await (opts.fetch ?? fetch)(from, { redirect: 'error' });
    if (!res.ok || !res.body) return { kind: 'error', message: `The update download failed (${res.status}).` };
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      n += c.byteLength;
      // Never read past the signed size.
      if (n > m.size) return { kind: 'rejected', message: 'Update refused: the download is larger than its signed size.' };
      chunks.push(c);
    }
    bytes = Buffer.concat(chunks);
  } catch {
    return { kind: 'error', message: 'Could not download the update.' };
  }
  if (!verifyArtifact(bytes, m)) return { kind: 'rejected', message: 'Update refused: the download does not match its signed hash.' };
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(m.version)) return { kind: 'rejected', message: 'Update refused: bad version.' };
  const name = path.basename(signed.pathname).replace(/[^0-9A-Za-z._-]/g, '_') || 'update.zip';
  const dir = path.join(opts.stagingDir, m.version);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, `${name}.part`), bytes, { mode: 0o600 });
  await rename(path.join(dir, `${name}.part`), path.join(dir, name));
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  return {
    kind: 'staged',
    version: m.version,
    path: path.join(dir, name),
    message: `Version ${m.version} was downloaded and matches its signed hash. Installing updates is not available in test builds yet.`,
  };
}
