/**
 * Real hardware probing. Read-only: it runs fixed system tools with fixed arguments, never a shell,
 * with short timeouts, and treats every failure as "unknown" rather than an error. All OS access
 * comes in through `ProbeDeps` so tests can drive it with fixtures.
 */
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { overallGpuConfidence, parseNvidiaSmi, parseSystemProfilerDisplays, parseWinVideoControllers, type Gpu, type HardwareReport } from './hardware';

export type ProbeDeps = {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  cpus: () => Array<{ model: string }>;
  totalmem: () => number;
  /** Runs a binary with arguments (no shell) and resolves stdout, or null on any failure. */
  run: (file: string, args: string[], timeoutMs: number) => Promise<string | null>;
  /** Free bytes available to this user on the volume holding `dir`, or null. */
  freeDisk: (dir: string) => Promise<number | null>;
};

export function systemProbeDeps(): ProbeDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpus: () => os.cpus(),
    totalmem: () => os.totalmem(),
    run: (file, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false }, (err, stdout) => resolve(err ? null : String(stdout)));
      }),
    freeDisk: async (dir) => {
      try {
        const s = await statfs(dir);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return null;
      }
    },
  };
}

const T = 8_000;

async function probeGpus(d: ProbeDeps): Promise<{ gpus: Gpu[]; probed: boolean; note?: string }> {
  if (d.platform === 'darwin') {
    const out = await d.run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], T);
    if (out === null) return { gpus: [], probed: false, note: 'Could not read the display report from system_profiler.' };
    try {
      return { gpus: parseSystemProfilerDisplays(JSON.parse(out)), probed: true };
    } catch {
      return { gpus: [], probed: false, note: 'The display report was not readable.' };
    }
  }
  if (d.platform === 'win32') {
    const out = await d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'], T);
    if (out === null || !out.trim()) return { gpus: [], probed: false, note: 'Could not list video controllers.' };
    try {
      return { gpus: parseWinVideoControllers(JSON.parse(out)), probed: true };
    } catch {
      return { gpus: [], probed: false, note: 'The video controller list was not readable.' };
    }
  }
  if (d.platform === 'linux') {
    const out = await d.run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], T);
    if (out !== null) return { gpus: parseNvidiaSmi(out), probed: true };
    // Without vendor tools we cannot measure VRAM, so we say so instead of guessing.
    return { gpus: [], probed: false, note: 'No NVIDIA tools found; other GPUs on Linux are not measured yet.' };
  }
  return { gpus: [], probed: false, note: 'GPU detection is not supported on this system.' };
}

export async function detectHardware(d: ProbeDeps, diskDir: string): Promise<HardwareReport> {
  const notes: string[] = [];
  const cpus = d.cpus();
  const model = (cpus[0]?.model ?? '').trim().slice(0, 200);
  const appleSilicon = d.platform === 'darwin' && d.arch === 'arm64';
  const gpu = await probeGpus(d);
  if (gpu.note) notes.push(gpu.note);
  const ram = d.totalmem();
  const free = await d.freeDisk(diskDir);
  if (free === null) notes.push('Could not read free disk space.');
  const platform = d.platform === 'darwin' || d.platform === 'win32' || d.platform === 'linux' ? d.platform : 'other';
  return {
    os: { platform, release: d.release.slice(0, 100) },
    cpu: { arch: d.arch, model, cores: cpus.length, appleSilicon },
    ramBytes: ram > 0 ? ram : null,
    gpus: gpu.gpus,
    freeDiskBytes: free,
    confidence: { ram: ram > 0 ? 'measured' : 'unknown', gpu: overallGpuConfidence(gpu.gpus, gpu.probed), disk: free === null ? 'unknown' : 'measured' },
    notes,
  };
}
