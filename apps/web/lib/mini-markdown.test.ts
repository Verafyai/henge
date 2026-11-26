import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './mini-markdown';

const spec = readFileSync(fileURLToPath(new URL('../content/henge-spec.md', import.meta.url)), 'utf8');

describe('mini markdown', () => {
  it('parses headings, lists, tasks, code, tables and rules', () => {
    const blocks = parseMarkdown(
      ['## 6. A title', '', 'Some `code` and **bold**', 'continued.', '', '- one', '- [ ] todo', '  ```', '  a: 1', '  ```', '', '1. first', '2. second', '', '| A | B |', '|---|---|', '| `x|y` | z |', '', '---'].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'code', 'list', 'table', 'rule']);
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, text: '6. A title', id: '6-a-title' });
    expect(blocks[1]).toEqual({ type: 'paragraph', text: 'Some `code` and **bold** continued.' });
    expect(blocks[2]).toEqual({ type: 'list', ordered: false, items: [{ text: 'one', task: false }, { text: 'todo', task: true }] });
    expect(blocks[3]).toEqual({ type: 'code', lang: '', text: 'a: 1' });
    expect(blocks[5]).toEqual({ type: 'table', head: ['A', 'B'], rows: [['`x|y`', 'z']] });
    expect(parseInline('Some `code` and **bold**')).toEqual([
      { t: 'text', v: 'Some ' },
      { t: 'code', v: 'code' },
      { t: 'text', v: ' and ' },
      { t: 'strong', v: 'bold' },
    ]);
  });

  it('renders every heading of spec sections 6 and 7', () => {
    const headings = parseMarkdown(spec).flatMap((b) => (b.type === 'heading' ? [b.text] : []));
    expect(headings[0]).toBe('6. Workstream C: the `.henge` file format, v1');
    expect(headings).toContain('7. Workstream D: Glyphs and Runes');
    expect(headings).toContain('7.1 Built-in Glyphs (publisher `verafy`)');
    expect(headings.filter((h) => /^6\.\d/.test(h))).toHaveLength(7);
    expect(headings.filter((h) => /^7\.\d/.test(h))).toHaveLength(7);
  });

  it('keeps the two tables and both code blocks of the spec text', () => {
    const blocks = parseMarkdown(spec);
    const tables = blocks.filter((b) => b.type === 'table');
    expect(tables).toHaveLength(2);
    expect(blocks.filter((b) => b.type === 'code')).toHaveLength(2);
    expect(tables[1]?.type === 'table' && tables[1].rows.map((r) => r[0])).toEqual([
      'Governance Glyph',
      'Treasury Glyph',
      'Benchmark Glyph',
      'Strategy Glyph',
      'Learnings Glyph',
      'Moderation Glyph',
    ]);
  });

  it('has no em or en dashes in the spec text', () => {
    expect(spec).not.toMatch(/[\u2013\u2014]/);
  });
});
