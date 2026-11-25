/**
 * Local test-signed internal-channel package (SPEC 15.1).
 *
 *   pnpm --filter @swarm-explorer/client package:internal [--version 0.2.0-internal.1]
 *
 * 1. Bakes the TEST release public key and the local API URL into the build.
 * 2. Packages an unsigned (ad-hoc on Apple silicon) zip with Electron fuses set.
 * 3. Signs an internal manifest over the real zip with the TEST key and records it
 *    in the local database. Nothing is uploaded or published anywhere.
 *
 * Stop the dev server first: the embedded database allows one process.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@swarm-explorer/db';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const version = arg('version', '0.2.0-internal.1');
const appDir = path.resolve(import.meta.dirname, '..');
const pubPath = path.join(repoRoot(), '.data', 'release-test', 'public.txt');
const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd: appDir, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });

if (!existsSync(pubPath)) run('pnpm', ['release:test']); // Creates the TEST key pair.
const publicKey = readFileSync(pubPath, 'utf8').trim();

run('pnpm', ['exec', 'electron-vite', 'build'], {
  MAIN_VITE_RELEASE_PUBKEY: publicKey,
  MAIN_VITE_API_URL: arg('api', 'http://localhost:3000'),
});
run('pnpm', ['exec', 'electron-builder', '--config', 'electron-builder.yml', '--publish', 'never', `-c.extraMetadata.version=${version}`], {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
});

const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform as 'darwin' | 'win32' | 'linux'];
const releaseDir = path.join(appDir, 'release');
const zip = readdirSync(releaseDir).find((f) => f === `SwarmExplorer-${version}-${os}-${process.arch}.zip` || f === `SwarmExplorer-${version}-${os}-${process.arch}.tar.gz`);
if (!zip) throw new Error(`No artifact for ${version} in ${releaseDir}`);

run('pnpm', ['release:test', '--version', version, '--artifact', path.join(releaseDir, zip)]);
console.log(`Test-signed internal build ${version}: ${path.join('apps/client/release', zip)}`);
