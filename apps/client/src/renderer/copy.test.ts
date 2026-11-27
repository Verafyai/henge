import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Copy denylist for everything the renderer can show (spin-out spec v2, guardrails 7 and 8): no em or
 * en dashes, and none of the retired names. Comments are stripped first; identifiers are code, but the
 * words are checked everywhere else, including the page title.
 */
const ROOT = __dirname;
const DENY: Array<[RegExp, string]> = [
  [/—/, 'em dash (U+2014)'],
  [/–/, 'en dash (U+2013)'],
  [/\\u201[34]/, 'escaped em or en dash'],
  [/&[mn]dash;/, 'dash entity'],
  [/\bplugins?\b/i, 'retired name "plugin" (say Glyph)'],
  [/\bbots?\b/i, 'retired name "bot" (say agent)'],
  [/Swarm ?Explorer|SwarmStarter/i, 'retired product name (say Henge)'],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|html|css)$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
  });
}

/** Drops comments and import specifiers (package names such as @swarm-explorer/* are not copy). */
function visible(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
    .replace(/import\(\s*['"][^'"]+['"]\s*\)/g, '');
}

describe('renderer copy denylist', () => {
  const all = files(ROOT);
  it('scans the renderer', () => {
    expect(all.length).toBeGreaterThan(20);
  });
  for (const f of all) {
    it(path.relative(ROOT, f), () => {
      const lines = visible(readFileSync(f, 'utf8')).split('\n');
      const hits: string[] = [];
      lines.forEach((l, i) => {
        for (const [re, why] of DENY) if (re.test(l)) hits.push(`${i + 1}: ${why}: ${l.trim().slice(0, 120)}`);
      });
      expect(hits).toEqual([]);
    });
  }
});
