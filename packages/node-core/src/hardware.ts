/**
 * Hardware report (SPEC 5.1 step 1). Every measured value carries a confidence, and unknown is
 * allowed: a value we could not measure stays null instead of being guessed.
 */
import { z } from 'zod';

export const confidenceSchema = z.enum(['measured', 'estimated', 'unknown']);
export type Confidence = z.infer<typeof confidenceSchema>;

export const gpuVendorSchema = z.enum(['apple', 'nvidia', 'amd', 'intel', 'other']);
export type GpuVendor = z.infer<typeof gpuVendorSchema>;

export const gpuSchema = z.object({
  vendor: gpuVendorSchema,
  /** Shown only on this device. Never sent to the server (SPEC 12: minimized). */
  name: z.string().max(200),
  vramBytes: z.number().int().nonnegative().nullable(),
  /** Apple Silicon shares memory with the CPU; discrete cards have their own. */
  memory: z.enum(['unified', 'dedicated', 'shared', 'unknown']),
  vramConfidence: confidenceSchema,
});
export type Gpu = z.infer<typeof gpuSchema>;

export const hardwareReportSchema = z.object({
  os: z.object({ platform: z.enum(['darwin', 'win32', 'linux', 'other']), release: z.string().max(100) }),
  cpu: z.object({ arch: z.string().max(20), model: z.string().max(200), cores: z.number().int().nonnegative(), appleSilicon: z.boolean() }),
  ramBytes: z.number().int().nonnegative().nullable(),
  gpus: z.array(gpuSchema).max(16),
  freeDiskBytes: z.number().int().nonnegative().nullable(),
  confidence: z.object({ ram: confidenceSchema, gpu: confidenceSchema, disk: confidenceSchema }),
  /** Probes that failed or were missing, for the "what we could not detect" note. */
  notes: z.array(z.string().max(300)).max(20),
});
export type HardwareReport = z.infer<typeof hardwareReportSchema>;

const MIB = 1024 * 1024;

export function vendorOf(name: string): GpuVendor {
  const n = name.toLowerCase();
  if (/\bapple\b/.test(n)) return 'apple';
  if (/nvidia|geforce|quadro|tesla|rtx|gtx/.test(n)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b/.test(n)) return 'amd';
  if (/intel|iris|uhd graphics/.test(n)) return 'intel';
  return 'other';
}

/**
 * macOS: `system_profiler SPDisplaysDataType -json`. Apple GPUs report no VRAM because memory is
 * unified; Intel Macs report `spdisplays_vram` such as "1536 MB" or "8 GB".
 */
export function parseSystemProfilerDisplays(raw: unknown): Gpu[] {
  const items = (raw as { SPDisplaysDataType?: unknown })?.SPDisplaysDataType;
  if (!Array.isArray(items)) return [];
  return items.flatMap((it: Record<string, unknown>): Gpu[] => {
    const name = String(it['sppci_model'] ?? it['_name'] ?? '').slice(0, 200);
    if (!name) return [];
    const vendor = vendorOf(`${name} ${String(it['spdisplays_vendor'] ?? '')}`);
    const vramText = String(it['spdisplays_vram'] ?? it['spdisplays_vram_shared'] ?? '');
    const m = /^(\d+(?:\.\d+)?)\s*(MB|GB)$/i.exec(vramText.trim());
    const vram = m ? Math.round(Number(m[1]) * (m[2]!.toUpperCase() === 'GB' ? 1024 : 1) * MIB) : null;
    if (vendor === 'apple') return [{ vendor, name, vramBytes: null, memory: 'unified', vramConfidence: 'unknown' }];
    const shared = 'spdisplays_vram_shared' in it && !('spdisplays_vram' in it);
    return [{ vendor, name, vramBytes: vram, memory: vram === null ? 'unknown' : shared ? 'shared' : 'dedicated', vramConfidence: vram === null ? 'unknown' : 'measured' }];
  });
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (memory in MiB). */
export function parseNvidiaSmi(text: string): Gpu[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 16)
    .flatMap((line) => {
      const [name, mem] = line.split(',').map((s) => s.trim());
      if (!name) return [];
      const mib = Number(mem);
      const ok = Number.isFinite(mib) && mib > 0;
      return [{ vendor: 'nvidia' as const, name: name.slice(0, 200), vramBytes: ok ? Math.round(mib * MIB) : null, memory: 'dedicated' as const, vramConfidence: ok ? ('measured' as const) : ('unknown' as const) }];
    });
}

/**
 * Windows: `Get-CimInstance Win32_VideoController | Select Name,AdapterRAM | ConvertTo-Json`.
 * AdapterRAM is a 32-bit field that caps near 4 GiB, so a value at the cap is only a lower bound.
 */
export function parseWinVideoControllers(raw: unknown): Gpu[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return list.slice(0, 16).flatMap((it: Record<string, unknown>) => {
    const name = String(it['Name'] ?? '').slice(0, 200);
    if (!name) return [];
    const vendor = vendorOf(name);
    const ram = typeof it['AdapterRAM'] === 'number' && it['AdapterRAM'] > 0 ? it['AdapterRAM'] : null;
    const capped = ram !== null && ram >= 4_293_918_720; // 0xFFF00000 and up: the field overflowed.
    const integrated = vendor === 'intel';
    return [
      {
        vendor,
        name,
        vramBytes: ram,
        memory: ram === null ? ('unknown' as const) : integrated ? ('shared' as const) : ('dedicated' as const),
        vramConfidence: ram === null ? ('unknown' as const) : capped ? ('estimated' as const) : ('measured' as const),
      },
    ];
  });
}

export function overallGpuConfidence(gpus: Gpu[], probed: boolean): Confidence {
  if (!probed) return 'unknown';
  if (gpus.length === 0) return 'estimated'; // A probe ran and found nothing it recognizes.
  if (gpus.every((g) => g.vramConfidence === 'measured' || g.memory === 'unified')) return 'measured';
  return 'estimated';
}
