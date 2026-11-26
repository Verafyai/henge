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

/**
 * Normalizes slider weights to integer basis points summing to exactly 10,000 (SPEC 7.1), by the
 * largest remainder method. Ties go to the earlier entry. All-zero weights become equal shares.
 */
export function normalizeShares(weights: readonly number[]): number[] {
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError('share weights must be finite and non-negative');
  if (weights.length === 0) return [];
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return equalShares(weights.length);
  const exact = weights.map((w) => (w * TOTAL_SHARE_BP) / total);
  const out = exact.map(Math.floor);
  let left = TOTAL_SHARE_BP - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left--;
  }
  return out;
}

/** True when shares differ from equal shares, so a new join must ask before rebalancing (SPEC 7.1). */
export function sharesCustomized(shares: readonly number[]): boolean {
  const eq = equalShares(shares.length);
  return shares.some((s, i) => s !== eq[i]);
}

/** Percent text for a share, one decimal at most: 3334 bp is "33.3%". */
export function formatShare(bp: number): string {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}
