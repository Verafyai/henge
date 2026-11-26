/**
 * Landing markdown sanitizer (spin-out spec v2, 6.5 step 6). A pure function: no DOM, no network.
 *
 * - Raw HTML is reduced to a small allowlist of formatting tags with an allowlist of attributes.
 *   Everything else is dropped (script, style, iframe, form and their contents) or escaped, so no
 *   script, iframe, form or inline event handler survives.
 * - Links may use https, mailto, an in-page anchor or a bundle-relative path.
 * - Images may come only from the bundle: a relative path that stays inside it (and, when the
 *   bundle's file list is given, names a file that exists). Other images become their alt text.
 * - Fenced code blocks and inline code are left as written; they render as text.
 */

export interface SanitizeOptions {
  /** Bundle path of the markdown file, for example `landing/README.md`. Relative paths resolve from its folder. */
  path?: string;
  /** Every file in the bundle. When given, an image must name one of them. */
  bundleFiles?: Iterable<string>;
}

export interface SanitizeResult {
  markdown: string;
  /** What was removed or neutralized, for logs and the publisher preview. */
  removed: string[];
}

const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'textarea', 'select', 'template', 'noscript', 'svg', 'math', 'title', 'xmp', 'noembed', 'noframes', 'plaintext'];
const ALLOWED_TAGS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  ...Object.fromEntries(
    ['b', 'i', 'em', 'strong', 'code', 'pre', 'br', 'hr', 'p', 'ul', 'ol', 'li', 'blockquote', 'details', 'summary', 'sub', 'sup', 'kbd', 'del', 's', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].map((t) => [t, [] as string[]]),
  ),
};

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', sol: '/' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** The scheme of a URL after entity decoding and removal of whitespace and control characters. */
function schemeOf(url: string): string | null {
  const clean = decodeEntities(url).replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (clean.startsWith('//')) return '//';
  const m = /^([a-z][a-z0-9+.-]*):/.exec(clean);
  return m ? m[1]! : null;
}

function normalizeBundlePath(ref: string, fromPath: string | undefined): string | null {
  const clean = decodeEntities(ref).split(/[?#]/)[0]!;
  if (!clean || clean.startsWith('/') || clean.includes('\\')) return null;
  const parts = fromPath && fromPath.includes('/') ? fromPath.split('/').slice(0, -1) : [];
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/') || null;
}

export function isSafeLinkUrl(url: string): boolean {
  const s = schemeOf(url);
  return s === null || s === 'https' || s === 'mailto';
}

function makeImageCheck(opts: SanitizeOptions) {
  const files = opts.bundleFiles ? new Set(opts.bundleFiles) : null;
  return (src: string): boolean => {
    if (schemeOf(src) !== null) return false;
    const p = normalizeBundlePath(src, opts.path);
    return p !== null && (!files || files.has(p));
  };
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeText = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const TAG_RE = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>$/;

function sanitizeHtml(text: string, imageOk: (s: string) => boolean, removed: string[]): string {
  let t = text;
  // Dangerous elements go with their contents.
  for (const tag of DROP_WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi');
    t = t.replace(re, () => {
      removed.push(`<${tag}> element`);
      return '';
    });
  }
  return t.replace(/<!--[\s\S]*?(?:-->|$)|<[!?][^>]*>?|<\/?[A-Za-z][^<>]*>?/g, (m) => {
    if (m.startsWith('<!--') || m.startsWith('<!') || m.startsWith('<?')) {
      removed.push('HTML comment or declaration');
      return '';
    }
    // CommonMark autolinks.
    if (/^<(https:\/\/|mailto:)[^\s<>]*>$/i.test(m)) return m;
    const tag = TAG_RE.exec(m);
    if (!tag) {
      removed.push(`malformed tag ${m.slice(0, 40)}`);
      return escapeText(m);
    }
    const [, close, rawName, attrs, selfClose] = tag;
    const name = rawName!.toLowerCase();
    const allowed = ALLOWED_TAGS[name];
    if (!allowed) {
      removed.push(`<${name}> tag`);
      return '';
    }
    if (close) return `</${name}>`;
    const kept: string[] = [];
    for (const a of attrs!.matchAll(ATTR_RE)) {
      const key = a[1]!.toLowerCase();
      const raw = a[2] ?? '';
      const val = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
      if (!allowed.includes(key)) {
        removed.push(`${key} attribute on <${name}>`);
        continue;
      }
      if (key === 'href' && !isSafeLinkUrl(val)) {
        removed.push(`unsafe link ${val.slice(0, 60)}`);
        continue;
      }
      if (key === 'src' && !imageOk(val)) {
        removed.push(`image not from the bundle ${val.slice(0, 60)}`);
        return '';
      }
      kept.push(`${key}="${escapeAttr(decodeEntities(val))}"`);
    }
    if (name === 'img' && !kept.some((k) => k.startsWith('src='))) return '';
    return `<${name}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClose ? ' /' : ''}>`;
  });
}

function sanitizeMarkdownLinks(text: string, imageOk: (s: string) => boolean, removed: string[], remoteImageRefs: Set<string>): string {
  // Inline links and images: [text](url "title") and ![alt](url "title").
  let t = text.replace(/(!?)\[([^\]]*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g, (m, bang: string, label: string, rawUrl: string) => {
    const url = rawUrl.startsWith('<') ? rawUrl.slice(1, -1) : rawUrl;
    if (bang) {
      if (imageOk(url)) return m;
      removed.push(`image not from the bundle ${url.slice(0, 60)}`);
      return label;
    }
    if (isSafeLinkUrl(url)) return m;
    removed.push(`unsafe link ${url.slice(0, 60)}`);
    return label;
  });
  // Reference images whose definition points outside the bundle.
  t = t.replace(/!\[([^\]]*)\](?:\[([^\]]*)\])?(?!\()/g, (m, alt: string, ref: string | undefined) => {
    const key = (ref || alt).trim().toLowerCase();
    if (!remoteImageRefs.has(key)) return m;
    removed.push(`image not from the bundle [${key}]`);
    return alt;
  });
  return t;
}

/** Sanitize a landing page's markdown. Safe to run on any input; never throws. */
export function sanitizeLandingMarkdown(markdown: string, opts: SanitizeOptions = {}): SanitizeResult {
  const removed: string[] = [];
  const imageOk = makeImageCheck(opts);
  const out: string[] = [];
  const remoteImageRefs = new Set<string>();

  // Reference definitions: drop unsafe ones; remember those that cannot be images.
  const linesIn = markdown.replace(/\r\n?/g, '\n').split('\n');
  const defRe = /^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)(.*)$/;
  let fence: string | null = null;
  const segments: { code: boolean; text: string }[] = [];
  for (const line of linesIn) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      segments.push({ code: true, text: line });
      if (f && f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      segments.push({ code: true, text: line });
      continue;
    }
    const d = defRe.exec(line);
    if (d) {
      const url = d[2]!.startsWith('<') ? d[2]!.slice(1, -1) : d[2]!;
      if (!isSafeLinkUrl(url)) {
        removed.push(`unsafe link definition [${d[1]}]`);
        continue;
      }
      if (!imageOk(url)) remoteImageRefs.add(d[1]!.trim().toLowerCase());
    }
    segments.push({ code: false, text: line });
  }

  // Group consecutive prose lines so multi-line HTML is handled as one block.
  let prose: string[] = [];
  const flush = () => {
    if (!prose.length) return;
    const block = prose.join('\n');
    // Inline code spans stay verbatim.
    const parts = block.split(/(`+[^`]*?`+)/g);
    out.push(parts.map((p, i) => (i % 2 ? p : sanitizeMarkdownLinks(sanitizeHtml(p, imageOk, removed), imageOk, removed, remoteImageRefs))).join(''));
    prose = [];
  };
  for (const s of segments) {
    if (s.code) {
      flush();
      out.push(s.text);
    } else prose.push(s.text);
  }
  flush();
  return { markdown: out.join('\n'), removed };
}
