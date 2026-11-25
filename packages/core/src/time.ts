const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Short countdown, for lease deadlines and pending windows: "12 days", "5 hours", "Ended". */
export function timeLeft(deadline: Date, now: Date = new Date()): { value: number; unit: string; label: string } {
  const ms = deadline.getTime() - now.getTime();
  if (ms <= 0) return { value: 0, unit: 'ended', label: 'Ended' };
  if (ms >= 2 * DAY) {
    const d = Math.floor(ms / DAY);
    return { value: d, unit: 'days', label: `${d} days` };
  }
  const h = Math.max(1, Math.floor(ms / HOUR));
  return { value: h, unit: h === 1 ? 'hour' : 'hours', label: `${h} ${h === 1 ? 'hour' : 'hours'}` };
}

/**
 * Timestamps are stored in UTC and shown in the user's zone with a zone label
 * (SPEC 12), for example "Dec 6, 2026, 4:12 PM PST". `timeZone` defaults to the
 * viewer's own zone.
 */
export function formatDeadline(deadline: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(deadline);
}
