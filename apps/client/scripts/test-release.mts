/**
 * Test-only release signing (SPEC 15.1). Generates a per-machine
 * ed25519 TEST key in .data/release-test and publishes a signed internal-channel
 * manifest row into the local database. Never used for Stable or Beta, and
 * never with production keys: those stay offline (docs/CERTIFICATES.md).
 *
 *   pnpm --filter @swarm-explorer/client release:test [--version 0.2.0-internal.1] [--rollout 100] [--artifact path.zip]
 *
 * Without --artifact the manifest describes a small placeholder payload, which
 * is enough for the update check tests. `package:internal` passes the real zip.
 * The payload is also written to .data/release-test/files/<url path>, so a local
 * mirror (SWARM_EXPLORER_RELEASE_MIRROR, unpackaged runs only) can serve it.
 *
 * Stop the dev server first: the embedded database allows one process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateReleaseKeyPair, sha256Hex, signManifest, type Manifest } from '@swarm-explorer/api-client/release';
import { getDb, clientReleases, repoRoot, usingPglite } from '@swarm-explorer/db';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

if (!usingPglite()) {
  console.error('release:test only writes to the local embedded database. Unset DATABASE_URL.');
  process.exit(1);
}

const dir = path.join(repoRoot(), '.data', 'release-test');
mkdirSync(dir, { recursive: true });
const privPath = path.join(dir, 'private.pem');
const pubPath = path.join(dir, 'public.txt');
if (!existsSync(privPath)) {
  const k = generateReleaseKeyPair();
  writeFileSync(privPath, k.privateKeyPem, { mode: 0o600 });
  writeFileSync(pubPath, `${k.publicKey}\n`);
  console.log('Generated a new TEST release key in .data/release-test');
}
const privateKeyPem = readFileSync(privPath, 'utf8');

const version = arg('version', '0.2.0-internal.1');
const platform = arg('platform', process.platform);
const archName = arg('arch', process.arch);
const artifact = arg('artifact', '');
const payload = artifact ? readFileSync(artifact) : Buffer.from(`Henge ${version} ${platform}-${archName} test payload`);
const manifest: Manifest = {
  schema: 1,
  version,
  channel: 'internal',
  platform,
  arch: archName,
  url: `https://releases.swarm-explorer.test/internal/${version}/Henge-${version}-${platform}-${archName}.zip`,
  sha256: sha256Hex(payload),
  size: payload.byteLength,
  publishedAt: new Date().toISOString(),
  rollback: false,
  notes: 'Test-signed internal build (example).',
};
const signed = signManifest(manifest, privateKeyPem);

// The artifact itself, at its URL path under .data/release-test/files, so a local mirror of the
// pinned test host can serve it and the client can download and hash-check it end to end (M7).
const filePath = path.join(dir, 'files', ...new URL(manifest.url).pathname.split('/').filter(Boolean));
mkdirSync(path.dirname(filePath), { recursive: true });
writeFileSync(filePath, payload);

const db = await getDb();
await db
  .insert(clientReleases)
  .values({
    version,
    channel: 'internal',
    platform,
    arch: archName,
    url: manifest.url,
    sha256: manifest.sha256,
    manifest: signed.manifest,
    signature: signed.signature,
    notesMd: manifest.notes,
    rolloutPct: Number(arg('rollout', '100')),
  })
  .onConflictDoUpdate({
    target: [clientReleases.version, clientReleases.channel, clientReleases.platform, clientReleases.arch],
    set: { manifest: signed.manifest, signature: signed.signature, sha256: manifest.sha256, url: manifest.url, yankedAt: null },
  });
console.log(`Published test-signed internal build ${version} for ${platform}-${archName} (sha256 ${manifest.sha256.slice(0, 12)}, ${payload.byteLength} bytes).`);
process.exit(0);
