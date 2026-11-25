/**
 * Fixture hardware profiles (SPEC 16.4 M1 acceptance: "first run detects fixtures"). The desktop
 * client honors them only in unpackaged test runs; packaged builds always probe the real machine.
 */
import apple from '../fixtures/hardware/apple-silicon-32gb.json';
import linuxGtx from '../fixtures/hardware/linux-gtx-2gb.json';
import linuxUnmeasured from '../fixtures/hardware/linux-gpu-unmeasured.json';
import winIntegrated from '../fixtures/hardware/windows-integrated-only.json';
import winRtx from '../fixtures/hardware/windows-rtx-12gb.json';
import { hardwareReportSchema, type HardwareReport } from './hardware';

const raw = {
  'apple-silicon-32gb': apple,
  'windows-rtx-12gb': winRtx,
  'windows-integrated-only': winIntegrated,
  'linux-gpu-unmeasured': linuxUnmeasured,
  'linux-gtx-2gb': linuxGtx,
} as const;

export type HardwareFixtureName = keyof typeof raw;
export const HARDWARE_FIXTURE_NAMES = Object.keys(raw) as HardwareFixtureName[];

export function hardwareFixture(name: string): HardwareReport | null {
  if (!(name in raw)) return null;
  return hardwareReportSchema.parse(raw[name as HardwareFixtureName]);
}
