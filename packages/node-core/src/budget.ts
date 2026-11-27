/**
 * Daily spending cap (spin-out spec v2, 6.2 `participation.budget`, 6.4, 9.3). The cap is the
 * member's own number, kept on the device. Spend is what model sources report per call
 * (`cost_usd_micros`); local models report 0, so a cap only bites on paid calls. The guard runs
 * before every model call: a call may start only while today's spend is below the cap. With
 * `hard_stop` the node pauses when the cap is reached and shows DAILY_CAP_PAUSED.
 *
 * Amounts are integer USD micros (1 USD = 1,000,000), the unit the run record already uses.
 * "Today" is the computer's local calendar day.
 */

export const DAILY_CAP_PAUSED = 'Paused: daily cap reached';

export type SpendDay = { day: string; usdMicros: number };

export type BudgetSettings = {
  /** Null means no cap is set. */
  dailyCapUsdMicros: number | null;
};

/** Local calendar day as YYYY-MM-DD. */
export function localDay(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Today's spend; a record from another day counts as nothing spent yet. */
export function spentToday(s: SpendDay | null | undefined, now: Date): number {
  return s && s.day === localDay(now) ? s.usdMicros : 0;
}

/** Adds one call's reported cost. Negative or fractional reports are refused, never rounded down. */
export function addSpend(s: SpendDay | null | undefined, usdMicros: number, now: Date): SpendDay {
  if (!Number.isInteger(usdMicros) || usdMicros < 0) throw new Error('Spend must be a whole, non-negative number of USD micros.');
  return { day: localDay(now), usdMicros: spentToday(s, now) + usdMicros };
}

export type CapDecision = { ok: true; remainingUsdMicros: number | null } | { ok: false; code: 'daily_cap_reached'; detail: typeof DAILY_CAP_PAUSED };

/** May a model call (or a new task) start? Only while spend is strictly below the cap. */
export function capDecision(capUsdMicros: number | null, spentUsdMicros: number): CapDecision {
  if (capUsdMicros === null) return { ok: true, remainingUsdMicros: null };
  if (spentUsdMicros >= capUsdMicros) return { ok: false, code: 'daily_cap_reached', detail: DAILY_CAP_PAUSED };
  return { ok: true, remainingUsdMicros: capUsdMicros - spentUsdMicros };
}

/** The tighter of several caps (the node's own and each joined Henge's member cap). Null when none is set. */
export function effectiveCap(...caps: Array<number | null | undefined>): number | null {
  const set = caps.filter((c): c is number => typeof c === 'number');
  return set.length ? Math.min(...set) : null;
}

/** Parses a USD amount typed by the member ("0.01", "5") into micros. Null for an empty string. */
export function parseUsd(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(t)) throw new Error('Enter an amount in dollars, for example 0.50.');
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 1_000_000 + Number(frac.padEnd(6, '0'));
}
