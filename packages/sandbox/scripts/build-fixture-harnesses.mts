/**
 * Builds the fixture harness bundles' harness.wasm from TASK_HARNESS_WAT and re-pins each fixture
 * manifest's harness hash to the bundle digest. Run: pnpm --filter @swarm-explorer/sandbox build:fixtures
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundleDigest } from '@swarm-explorer/schema/node';
import { compileTaskHarness } from '../src/check-compile';

const FIX = path.join(import.meta.dirname, '..', '..', 'schema', 'fixtures');
const bundles: Record<string, string> = { 'lean-prover': 'challenge-vaults.yaml', 'prompt-guard-red-team': 'prompt-guard-red-team.yaml', 'verafy-juror': 'verafy-dao-juries.yaml' };
const wasm = await compileTaskHarness();
for (const [name, manifest] of Object.entries(bundles)) {
  const dir = path.join(FIX, 'harnesses', name);
  writeFileSync(path.join(dir, 'harness.wasm'), wasm);
  const hash = bundleDigest(dir);
  const mp = path.join(FIX, 'manifests', 'valid', manifest);
  const before = readFileSync(mp, 'utf8');
  const after = before.replace(/(harness: \{ name: [a-z-]+, version: [0-9.]+, hash: )sha256-[a-f0-9]{64}/, `$1${hash}`);
  if (after === before && !before.includes(hash)) throw new Error(`${manifest}: harness hash line not found`);
  writeFileSync(mp, after);
  console.log(`${name}: ${wasm.length} bytes, ${hash}`);
}
