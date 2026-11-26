import { describe, expect, it } from 'vitest';
import * as copy from './henge-landing-copy';

/**
 * Digits allowed in the copy: the step numbers 01 to 04 and the tokens in the spec's example
 * .henge snippet ("1.0" and the @^1 version ranges). Anything else is an invented number.
 */
const DIGIT_ALLOWLIST = ['01', '02', '03', '04', '"1.0"', '@^1'];

function strings(value: unknown, path = 'copy'): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

function copyProblems(entries: Array<[string, string]>): string[] {
  const problems: string[] = [];
  for (const [path, s] of entries) {
    if (s.includes('\u2014')) problems.push(`${path}: em dash`);
    if (s.includes('\u2013')) problems.push(`${path}: en dash`);
    let rest = s;
    for (const token of DIGIT_ALLOWLIST) rest = rest.split(token).join('');
    if (/\d/.test(rest)) problems.push(`${path}: digit outside the allowlist in "${s}"`);
  }
  return problems;
}

describe('henge landing copy', () => {
  const all = strings(copy);

  it('has copy to check', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it('has no em or en dashes and no digits outside the allowlist', () => {
    expect(copyProblems(all)).toEqual([]);
  });

  it('the checker catches dashes and stray numbers', () => {
    expect(copyProblems([['a', 'one \u2014 two']])).toEqual(['a: em dash']);
    expect(copyProblems([['b', 'one \u2013 two']])).toEqual(['b: en dash']);
    expect(copyProblems([['c', 'Join 1,200 members']])).toHaveLength(1);
    expect(copyProblems([['d', 'v0.3.0']])).toHaveLength(1);
    expect(copyProblems([['e', 'Step 05']])).toHaveLength(1);
    expect(copyProblems([['f', 'Step 03 and "1.0" and @^1']])).toEqual([]);
  });

  it('keeps the exact spec copy, with Rex\'s platform note', () => {
    expect(copy.hero.h1Lead + copy.hero.h1Accent).toBe('A Henge is a swarm you can join, like a social network for your agents.');
    expect(copy.hero.subBefore + copy.hero.subCode + copy.hero.subAfter).toBe(
      "Download the Henge client. Start your own Henge, or join someone else's by pasting a .henge link.",
    );
    expect(copy.hero.note).toBe('macOS first. Windows and Linux later. Not released yet.');
    expect(copy.nav.links.map((l) => l.label)).toEqual(['How it works', 'Glyphs', 'The .henge file', 'Science', 'Docs']);
    expect(copy.landingHeadings).toEqual([
      'Four steps, then your agent is in.',
      'Add a Glyph. Give your Henge a new power.',
      'Every Henge is a community.',
      'Your whole Henge is one file.',
      'Measured, not claimed.',
      'Bring your agent. Join a Henge.',
    ]);
  });

  it('never names a version or size on the download page', () => {
    expect(copyProblems(strings(copy.download))).toEqual([]);
    expect(JSON.stringify(copy.download)).not.toMatch(/\bMB\b|\bGB\b|\bv\d/);
  });
});
