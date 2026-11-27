/**
 * Landing markdown for the /s preview. The text is first sanitized by `sanitizeLandingMarkdown`
 * (packages/schema), then parsed into plain data by the /spec parser and rendered as React
 * elements, so no HTML string is ever injected. Raw HTML tags that survive the sanitizer are shown
 * as their text. Links are live only for https and mailto; bundle paths become plain text.
 * Images come only from the bundle, as data URLs the caller supplies.
 */
import { type Block, parseMarkdown } from './mini-markdown';

export type PreviewInline =
  | { t: 'text' | 'code' | 'strong'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'image'; alt: string; src: string };

/** The /spec parser knows ## and ###; landing files usually start at #. */
export function previewMarkdownBlocks(markdown: string): Block[] {
  let fence = false;
  const lines = markdown.split(/\r?\n/).map((l) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence || /^\s*(```|~~~)/.test(l)) return l;
    return l
      .replace(/^# (.*)$/, '## $1')
      .replace(/^#{4,6} (.*)$/, '### $1')
      .replace(/^\* (.*)$/, '- $1');
  });
  return parseMarkdown(lines.join('\n'));
}

const TOKEN = /(`[^`]+`|!\[[^\]]*\]\([^)\s]*\)|\[[^\]]+\]\([^)\s]*\)|\*\*[^*]+\*\*)/;
const stripTags = (s: string) => s.replace(/<\/?[A-Za-z][^<>]*>/g, '');

export function liveHref(href: string): string | null {
  const h = href.trim();
  return /^https:\/\/[^\s]+$/i.test(h) || /^mailto:[^\s]+$/i.test(h) ? h : null;
}

/** `image` maps a bundle path (relative to the markdown file) to a data URL, or null. */
export function parsePreviewInline(text: string, image: (src: string) => string | null): PreviewInline[] {
  const out: PreviewInline[] = [];
  for (const part of text.split(TOKEN)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      out.push({ t: 'code', v: part.slice(1, -1) });
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]*)\)$/.exec(part);
    if (img) {
      const src = image(img[2]!);
      out.push(src ? { t: 'image', alt: stripTags(img[1]!), src } : { t: 'text', v: stripTags(img[1]!) });
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]*)\)$/.exec(part);
    if (link) {
      const href = liveHref(link[2]!);
      out.push(href ? { t: 'link', v: stripTags(link[1]!), href } : { t: 'text', v: stripTags(link[1]!) });
      continue;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) {
      out.push({ t: 'strong', v: stripTags(part.slice(2, -2)) });
      continue;
    }
    const v = stripTags(part);
    if (v) out.push({ t: 'text', v });
  }
  return out;
}
