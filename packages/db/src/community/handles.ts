/**
 * Handles (spin-out spec 8.1, 8.2): 3 to 24 characters from `[a-z0-9._]`, case-insensitive, one global
 * namespace for humans and agents. Input is NFKC-normalized first; anything that still mixes scripts is
 * refused as confusable, and anything outside the allowed set is refused outright.
 */
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 24;
/** A handle can change once per 30 days; the old one is held for its owner for 30 days (spec 8.2). */
export const HANDLE_CHANGE_INTERVAL_MS = 30 * 24 * 3600 * 1000;
export const HANDLE_HOLD_MS = 30 * 24 * 3600 * 1000;

/**
 * Reserved: the spec's list (admin, henge, verafy, mod, everyone, here, system, Glyph names) plus the
 * role names (so `@role` mentions never collide with a person), the words Glyph and Rune, and a few
 * names people expect to be official.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'henge', 'verafy', 'mod', 'mods', 'moderator', 'moderators', 'everyone', 'here', 'system',
  'glyph', 'glyphs', 'rune', 'runes', 'governance', 'treasury', 'benchmark', 'strategy', 'learnings', 'moderation', 'community',
  'owner', 'maintainer', 'member', 'agent', 'observer', 'staff', 'support', 'help', 'official', 'root', 'api', 'null', 'undefined',
  'deleted', 'deleted_user', 'unknown', 'anonymous', 'you', 'me',
]);

export type HandleRefusal = 'length' | 'characters' | 'confusable' | 'format' | 'reserved';
export type HandleCheck = { ok: true; handle: string; key: string } | { ok: false; reason: HandleRefusal; message: string };

const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Hebrew', 'Arabic', 'Cherokee', 'Georgian', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Devanagari'] as const;
const SCRIPT_RES = SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')] as const);
const LETTER = /\p{L}/u;

function scriptOf(ch: string): string {
  for (const [name, re] of SCRIPT_RES) if (re.test(ch)) return name;
  return 'Other';
}

/** The set of scripts used by the letters in `s`. Digits and punctuation have no script here. */
export function scriptsIn(s: string): Set<string> {
  const out = new Set<string>();
  for (const ch of s) if (LETTER.test(ch)) out.add(scriptOf(ch));
  return out;
}

export function handleKey(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export function checkHandle(raw: string): HandleCheck {
  const handle = raw.normalize('NFKC').trim();
  if (/[^\x00-\x7f]/.test(handle)) {
    return scriptsIn(handle).size > 1
      ? { ok: false, reason: 'confusable', message: 'That handle mixes alphabets, so it could be mistaken for another one.' }
      : { ok: false, reason: 'characters', message: 'Handles use only letters a to z, digits, dots and underscores.' };
  }
  const key = handle.toLowerCase();
  if (key.length < HANDLE_MIN || key.length > HANDLE_MAX) return { ok: false, reason: 'length', message: `Handles are ${HANDLE_MIN} to ${HANDLE_MAX} characters.` };
  if (!/^[a-z0-9._]+$/.test(key)) return { ok: false, reason: 'characters', message: 'Handles use only letters a to z, digits, dots and underscores.' };
  if (!/^[a-z0-9].*[a-z0-9]$/.test(key) || key.includes('..')) {
    return { ok: false, reason: 'format', message: 'Handles start and end with a letter or digit and have no double dots.' };
  }
  if (RESERVED_HANDLES.has(key) || key.includes('verafy')) return { ok: false, reason: 'reserved', message: 'That handle is reserved.' };
  return { ok: true, handle: key, key };
}
