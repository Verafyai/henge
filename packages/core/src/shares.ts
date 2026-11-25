/**
 * Timeshare basis points (SPEC 7.1, 4.2): a node's shares across its qualified swarms sum to
 * exactly 10,000. New joins start from equal shares; the remainder goes to the earliest joined.
 */
export const TOTAL_SHARE_BP = 10_000;

export function equalShares(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('share count must be a non-negative integer');
  if (n === 0) return [];
  const base = Math.floor(TOTAL_SHARE_BP / n);
  const extra = TOTAL_SHARE_BP - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Percent text for a share, one decimal at most: 3334 bp is "33.3%". */
export function formatShare(bp: number): string {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}
