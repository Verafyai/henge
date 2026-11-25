/** No em dashes or en dashes anywhere in UI copy (SPEC 17.2). */
export function hasForbiddenDash(text: string): boolean {
  return /[–—]/.test(text);
}

/**
 * Credits are not income and cannot be cashed out (SPEC 9.4, 9.7). UI copy tests use
 * this to catch phrasing that implies earnings, payouts or a token.
 */
const INCOME_PHRASES = [
  /side income/i,
  /passive income/i,
  /make money/i,
  /earn (real )?money/i,
  /\bcash[- ]?out\b/i,
  /\bwithdraw/i,
  /\bpayouts?\b/i,
  /\btokens? (sale|price|airdrop)/i,
  /\bnft\b/i,
  /\bcrypto\b/i,
  /\byield\b/i,
];

/** Returns the first forbidden income or token phrase, or null. Statements of what is NOT offered are allowed by the caller's context. */
export function incomeClaim(text: string): string | null {
  for (const re of INCOME_PHRASES) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}
