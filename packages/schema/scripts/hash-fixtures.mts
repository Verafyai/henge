/**
 * Pin each fixture manifest's harness hash to the real digest of its fixture bundle.
 *   pnpm --filter @swarm-explorer/schema fixtures:hash
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundleDigest } from '../src/node';

const root = path.resolve(import.meta.dirname, '..', 'fixtures');
const dir = path.join(root, 'manifests', 'valid');
for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml'))) {
  const file = path.join(dir, f);
  const src = readFileSync(file, 'utf8');
  const name = /harness: \{ name: ([a-z0-9-]+),/.exec(src)?.[1];
  if (!name) throw new Error(`No harness name in ${f}`);
  const digest = bundleDigest(path.join(root, 'harnesses', name));
  writeFileSync(file, src.replace(/(harness: \{ name: [a-z0-9-]+, version: [^,]+, hash: )sha256-[a-f0-9]{64}/, `$1${digest}`));
  console.log(`${f}: ${name} ${digest}`);
}
