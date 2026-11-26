/**
 * A small Markdown parser for the /spec page (content/henge-spec.md). It covers exactly what the
 * spec text uses: ## and ### headings, paragraphs, - and 1. lists, "- [ ]" task items, fenced code
 * (also indented under a list item), pipe tables, --- rules, `code` and **bold**. It returns plain
 * data, rendered as React elements, so no HTML string is ever injected.
 */

export type Inline = { t: 'text' | 'code' | 'strong'; v: string };
export type ListItem = { text: string; task: boolean };
export type Block =
  | { type: 'heading'; level: 2 | 3; text: string; id: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'rule' };

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Splits a table row on pipes that are not inside backticks. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inCode = false;
  for (const ch of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const BULLET = /^- (\[ \] )?(.*)$/;
const NUMBERED = /^\d+\. (.*)$/;
const FENCE = /^(\s*)```(\w*)\s*$/;

export function parseMarkdown(src: string): Block[] {
  const all = src.replace(/\r\n/g, '\n').split('\n');
  const at = (k: number): string => all[k] ?? '';
  const n = all.length;
  const blocks: Block[] = [];
  let i = 0;
  while (i < n) {
    const line = at(i);
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = (fence[1] ?? '').length;
      const body: string[] = [];
      i++;
      while (i < n && !FENCE.test(at(i))) {
        body.push(at(i).slice(Math.min(indent, at(i).length - at(i).trimStart().length)));
        i++;
      }
      i++;
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{2,3}) (.*)$/.exec(line);
    if (heading) {
      const text = (heading[2] ?? '').trim();
      blocks.push({ type: 'heading', level: (heading[1] ?? '').length as 2 | 3, text, id: slugify(text) });
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < n && at(i).startsWith('|')) {
        rows.push(cells(at(i)));
        i++;
      }
      const [head = [], sep, ...rest] = rows;
      const hasSep = sep?.every((c) => /^:?-+:?$/.test(c));
      blocks.push({ type: 'table', head, rows: hasSep ? rest : rows.slice(1) });
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const items: ListItem[] = [];
      while (i < n) {
        const l = at(i);
        const b = ordered ? null : BULLET.exec(l);
        const num = ordered ? NUMBERED.exec(l) : null;
        const last = items[items.length - 1];
        if (b) items.push({ text: b[2] ?? '', task: Boolean(b[1]) });
        else if (num) items.push({ text: num[1] ?? '', task: false });
        else if (l.trim() && /^\s+/.test(l) && !FENCE.test(l) && last) last.text += ` ${l.trim()}`;
        else break;
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < n && at(i).trim() && !FENCE.test(at(i)) && !/^(#{2,3} |\||- |\d+\. |---)/.test(at(i))) {
      para.push(at(i).trim());
      i++;
    }
    blocks.push({ type: 'paragraph', text: para.join(' ') });
  }
  return blocks;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) out.push({ t: 'code', v: part.slice(1, -1) });
    else if (part.startsWith('**') && part.endsWith('**') && part.length > 3) out.push({ t: 'strong', v: part.slice(2, -2) });
    else out.push({ t: 'text', v: part });
  }
  return out;
}
