// Fails if any vendored Prompt Guard file differs from the bytes pinned in vendor/PIN.json.
// To update: copy the new upstream files at a new commit, then rewrite PIN.json (VENDOR.md).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(readFileSync(`${root}vendor/PIN.json`, 'utf8'));
const bad = Object.entries(pin.files).filter(([f, h]) => createHash('sha256').update(readFileSync(`${root}${f}`)).digest('hex') !== h);
if (bad.length) {
  console.error(`Vendored Prompt Guard drifted from ${pin.commit}: ${bad.map(([f]) => f).join(', ')}`);
  process.exit(1);
}
console.log(`Prompt Guard pinned at ${pin.commit.slice(0, 7)}: ${Object.keys(pin.files).length} files match`);
