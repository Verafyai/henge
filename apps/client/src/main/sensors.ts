/**
 * What the run rules can observe on this computer (SPEC 7.2). Electron's powerMonitor gives the
 * system idle time and battery state; macOS also reports a coarse thermal state. CPU load comes from
 * the load average, which Windows does not provide. Metered networks cannot be detected, so that
 * reading is always null.
 *
 * Unpackaged test runs may point SWARM_EXPLORER_SENSOR_FIXTURE at a JSON file that is read on every
 * check, so tests can move between "busy" and "idle". Packaged builds ignore it.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { powerMonitor } from 'electron';
import type { Sensors } from '@swarm-explorer/node-core';
import { z } from 'zod';

const fixtureSchema = z
  .object({
    idleSeconds: z.number().nonnegative().nullable(),
    onBattery: z.boolean().nullable(),
    thermal: z.enum(['unknown', 'nominal', 'fair', 'serious', 'critical']).nullable().optional(),
    cpuLoadPct: z.number().nonnegative().nullable().optional(),
  })
  .strict();

export function readSensors(fixtureFile: string | null): Sensors {
  if (fixtureFile) {
    try {
      const f = fixtureSchema.parse(JSON.parse(readFileSync(fixtureFile, 'utf8')));
      return { idleSeconds: f.idleSeconds, onBattery: f.onBattery, thermal: f.thermal ?? null, cpuLoadPct: f.cpuLoadPct ?? null, metered: null };
    } catch {
      // An unreadable fixture measures nothing, so idle rules wait.
      return { idleSeconds: null, onBattery: null, thermal: null, cpuLoadPct: null, metered: null };
    }
  }
  let thermal: Sensors['thermal'] = null;
  if (process.platform === 'darwin') {
    try {
      thermal = powerMonitor.getCurrentThermalState();
    } catch {
      thermal = null;
    }
  }
  const cpus = os.cpus().length || 1;
  return {
    idleSeconds: powerMonitor.getSystemIdleTime(),
    onBattery: process.platform === 'darwin' || process.platform === 'win32' ? powerMonitor.isOnBatteryPower() : null,
    thermal,
    cpuLoadPct: process.platform === 'win32' ? null : Math.round((os.loadavg()[0]! / cpus) * 100),
    metered: null,
  };
}
