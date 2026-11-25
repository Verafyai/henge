/**
 * The minimized capability report sent with PUT /v1/nodes/{id}/capabilities (SPEC 12.1, 13.1).
 * Only the SPEC 12.1 columns leave the device, rounded so the report helps scheduling without
 * fingerprinting the machine: no GPU or CPU model names, no OS build, no paths.
 */
import { z } from 'zod';
import type { Confidence, HardwareReport } from './hardware';
import { bestGpu } from './recommend';
import { enforcementSupportSchema, type EnforcementSupport } from './run-rules';

const GIB = 1024 ** 3;

export const capabilityReportSchema = z.object({
  os: z.enum(['darwin', 'win32', 'linux', 'other']),
  cpu_class: z.enum(['apple-silicon', 'x86_64', 'arm64', 'other']).nullable(),
  ram_bytes: z.number().int().nonnegative().multipleOf(GIB).nullable(),
  gpu_family: z.enum(['apple', 'nvidia', 'amd', 'intel', 'other', 'none']).nullable(),
  vram_bytes: z.number().int().nonnegative().multipleOf(GIB).nullable(),
  free_disk_bytes: z.number().int().nonnegative().multipleOf(10 * GIB).nullable(),
  enforcement_support: enforcementSupportSchema,
  confidence: z.enum(['measured', 'estimated', 'unknown']),
});
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;

const floorTo = (n: number | null, step: number) => (n === null ? null : Math.floor(n / step) * step);

function weakest(cs: Confidence[]): Confidence {
  if (cs.includes('unknown')) return 'unknown';
  if (cs.includes('estimated')) return 'estimated';
  return 'measured';
}

export function minimizeCapabilities(hw: HardwareReport, support: EnforcementSupport): CapabilityReport {
  const gpu = bestGpu(hw);
  const arch = hw.cpu.arch === 'x64' ? 'x86_64' : hw.cpu.arch;
  const gpuProbed = hw.confidence.gpu !== 'unknown';
  return {
    os: hw.os.platform,
    cpu_class: hw.cpu.appleSilicon ? 'apple-silicon' : arch === 'x86_64' || arch === 'arm64' ? arch : 'other',
    ram_bytes: floorTo(hw.ramBytes, GIB),
    gpu_family: gpu ? gpu.vendor : gpuProbed ? 'none' : null,
    vram_bytes: gpu && gpu.memory === 'dedicated' ? floorTo(gpu.vramBytes, GIB) : null,
    free_disk_bytes: floorTo(hw.freeDiskBytes, 10 * GIB),
    enforcement_support: support,
    confidence: weakest([hw.confidence.ram, hw.confidence.gpu, hw.confidence.disk]),
  };
}
