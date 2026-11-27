/**
 * Build-time fetch of the Temporal CLI, which carries the local dev server the node supervises
 * (spin-out spec v2, 9.3). Production code never downloads it: the app only runs the binary this
 * script placed in `resources/temporal/<platform>-<arch>/`, which electron-builder copies into the
 * package (`extraResources`).
 *
 *   pnpm --filter @swarm-explorer/client fetch:temporal [--platform darwin --arch arm64]
 *
 * The archive must match the pinned SHA-256 below (taken from the release's checksums.txt), or
 * nothing is written. Temporal CLI is MIT licensed; the license text is copied next to the binary.
 * Safe to run again: a binary that already matches the pinned version is kept.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEMPORAL_CLI } from '../src/main/temporal/pin';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
const key = `${platform}-${arch}` as keyof typeof TEMPORAL_CLI.archives;
const pin = TEMPORAL_CLI.archives[key];
if (!pin) {
  console.error(`No pinned Temporal CLI archive for ${key}.`);
  process.exit(1);
}

const appDir = path.resolve(import.meta.dirname, '..');
const outDir = path.join(appDir, 'resources', 'temporal', key);
const exe = platform === 'win32' ? 'temporal.exe' : 'temporal';
const stamp = path.join(outDir, 'VERSION');
if (existsSync(path.join(outDir, exe)) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === `${TEMPORAL_CLI.version} ${pin.sha256}`) {
  console.log(`Temporal CLI ${TEMPORAL_CLI.version} for ${key} is already in place.`);
  process.exit(0);
}

const url = `https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI.version}/${pin.file}`;
console.log(`Fetching ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const bytes = Buffer.from(await res.arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== pin.sha256) throw new Error(`Checksum mismatch for ${pin.file}: expected ${pin.sha256}, got ${digest}. Nothing was written.`);
if (bytes.length !== pin.bytes) throw new Error(`Size mismatch for ${pin.file}: expected ${pin.bytes}, got ${bytes.length}. Nothing was written.`);

// Extract in an empty folder of its own, then copy only the binary and the license out.
const work = mkdtempSync(path.join(tmpdir(), 'henge-temporal-'));
try {
  const archive = path.join(work, pin.file);
  writeFileSync(archive, bytes);
  const extracted = path.join(work, 'x');
  mkdirSync(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted], { stdio: 'inherit' });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(path.join(extracted, exe), path.join(outDir, exe));
  if (platform !== 'win32') chmodSync(path.join(outDir, exe), 0o755);
  if (existsSync(path.join(extracted, 'LICENSE'))) copyFileSync(path.join(extracted, 'LICENSE'), path.join(outDir, 'LICENSE'));
  writeFileSync(stamp, `${TEMPORAL_CLI.version} ${pin.sha256}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Temporal CLI ${TEMPORAL_CLI.version} for ${key} verified (sha256 ${pin.sha256}) and placed in ${path.relative(appDir, outDir)}.`);
