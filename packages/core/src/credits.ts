/**
 * Credits are integers, always (SPEC 9.5, 12). Dollar amounts that come from provider
 * pricing are integer USD micros (millionths of a dollar), as in spend_caps (SPEC 12.1).
 * Formatting happens only at the edge.
 */
function assertInt(n: number, what: string) {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a safe integer`);
}

export function formatCredits(credits: number): string {
  assertInt(credits, 'credits');
  return `${new Intl.NumberFormat('en-US').format(credits)} ${Math.abs(credits) === 1 ? 'credit' : 'credits'}`;
}

/** Impact is a separate, nonspendable unit (SPEC 9.1). It is never formatted as credits. */
export function formatImpact(units: number): string {
  assertInt(units, 'impact');
  return `${new Intl.NumberFormat('en-US').format(units)} impact`;
}

export const USD_MICROS_PER_DOLLAR = 1_000_000;

/** "$0.004" for small API costs, "$12.50" for caps. Rounds to the nearest tenth of a cent for display only. */
export function formatUsdMicros(micros: number): string {
  assertInt(micros, 'usd micros');
  const dollars = micros / USD_MICROS_PER_DOLLAR;
  const small = Math.abs(micros) > 0 && Math.abs(micros) < 10_000;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: small ? 3 : 2,
    maximumFractionDigits: small ? 3 : 2,
  }).format(dollars);
}

export function usdToMicros(dollars: number): number {
  const m = Math.round(dollars * USD_MICROS_PER_DOLLAR);
  assertInt(m, 'usd micros');
  return m;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}
