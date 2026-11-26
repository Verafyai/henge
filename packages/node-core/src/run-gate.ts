/**
 * Run rule enforcement (SPEC 7.2). Given the user's rules, what this computer can measure right now
 * and what the platform can enforce, decide whether a new lease may start and whether running work
 * must stop. Rules that cannot be measured never block silently and are never shown as enforced:
 * the capability map in run-rules.ts says which are enforced, best effort or unavailable.
 *
 * A stop (idle broken, unplugged, thermal pressure, outside the schedule) abandons the running task
 * unpaid, the same as Pause. CPU load only holds back new leases, because the task itself adds load.
 */
import type { EnforcementSupport, RunRules } from './run-rules';

export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical';

/** What the desktop shell observed. Null means it could not be measured on this computer. */
export type Sensors = {
  idleSeconds: number | null;
  onBattery: boolean | null;
  thermal: ThermalState | null;
  cpuLoadPct: number | null;
  metered: boolean | null;
};

export type GateBlock = { rule: 'when' | 'power' | 'network' | 'temperature' | 'load'; detail: string };

export type GateDecision = {
  /** A new lease may start. */
  canStart: boolean;
  /** Running work must stop now and be abandoned. */
  mustStop: boolean;
  blocks: GateBlock[];
};

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** True when `now` (local time) falls in a schedule window. A window whose end is before its start runs past midnight. */
export function inSchedule(windows: Extract<RunRules['when'], { kind: 'schedule' }>['windows'], now: Date): boolean {
  const day = now.getDay();
  const t = now.getHours() * 60 + now.getMinutes();
  return windows.some((w) => {
    const start = minutes(w.start);
    const end = minutes(w.end);
    if (start === end) return w.days.includes(day);
    if (start < end) return w.days.includes(day) && t >= start && t < end;
    // Overnight: the part after start belongs to the listed day, the part before end to the next day.
    return (w.days.includes(day) && t >= start) || (w.days.includes((day + 6) % 7) && t < end);
  });
}

/** Thermal states that count as running hot. macOS reports states, not degrees, so this is best effort. */
const HOT: ThermalState[] = ['serious', 'critical'];

export function evaluateRunRules(rules: RunRules, sensors: Sensors, support: EnforcementSupport, now: Date): GateDecision {
  const stop: GateBlock[] = [];
  const hold: GateBlock[] = [];

  if (rules.when.kind === 'idle') {
    const need = rules.when.idleMinutes * 60;
    if (sensors.idleSeconds === null) stop.push({ rule: 'when', detail: 'Idle time could not be read, so nothing runs.' });
    else if (sensors.idleSeconds < need) stop.push({ rule: 'when', detail: `Waiting until this computer has been idle for ${rules.when.idleMinutes} minutes.` });
  } else if (rules.when.kind === 'schedule' && !inSchedule(rules.when.windows, now)) {
    stop.push({ rule: 'when', detail: 'Outside your schedule.' });
  }

  if (rules.power === 'plugged_in' && sensors.onBattery === true) stop.push({ rule: 'power', detail: 'On battery power. Work runs only when plugged in.' });

  // Metered networks cannot be detected on any platform we ship, so this never blocks (and the UI
  // says the rule is not available). If a sensor ever reports it, it is honored.
  if (rules.network === 'not_metered' && support.meteredNetwork !== 'unavailable' && sensors.metered === true) stop.push({ rule: 'network', detail: 'On a metered connection.' });

  if (support.temperature !== 'unavailable' && sensors.thermal && HOT.includes(sensors.thermal)) stop.push({ rule: 'temperature', detail: 'The system reports thermal pressure, so work is paused until it cools.' });

  if (support.cpuLoad !== 'unavailable' && sensors.cpuLoadPct !== null && sensors.cpuLoadPct > rules.maxLoadPct)
    hold.push({ rule: 'load', detail: `CPU load is above ${rules.maxLoadPct}%, so no new task starts.` });

  return { canStart: stop.length === 0 && hold.length === 0, mustStop: stop.length > 0, blocks: [...stop, ...hold] };
}
