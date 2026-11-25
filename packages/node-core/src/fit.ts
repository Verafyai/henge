/**
 * Fit for this machine (SPEC 5.4). Per Rex's decision of 2026-11-25 the UI shows only facts: whether
 * the model fits in memory, and the tokens per second measured on this machine. No "Runs well" or
 * "Runs slowly" labels ship until benchmark data from the alpha supports thresholds.
 *
 * Before download the estimate uses only memory facts: does the artifact fit in GPU memory, in
 * system memory, or in neither. That is a size comparison, not a speed claim. After download the
 * local benchmark decides, against per-runtime thresholds that ship with a catalog version. When no
 * approved calibration exists the benchmark is recorded and the memory estimate stands; we never
 * hardcode tokens-per-second thresholds of our own.
 */
import { z } from 'zod';
import type { HardwareReport } from './hardware';
import { bestGpu } from './recommend';

export const FIT_STATUSES = ['runs_well', 'runs_slowly', 'will_not_fit', 'unknown'] as const;
export type FitStatus = (typeof FIT_STATUSES)[number];
export const fitStatusSchema = z.enum(FIT_STATUSES);

/** Short factual label for the memory comparison. */
export const memoryFitLabel: Record<FitReason, string> = {
  gpu_memory: 'Fits in GPU memory',
  unified_memory: 'Fits in memory',
  system_memory_only: 'Fits in system memory only',
  too_large: 'Too large for this computer',
  memory_unknown: 'Memory not measured',
  benchmark: 'Measured',
  benchmark_uncalibrated: 'Measured',
};

export type FitReason = 'gpu_memory' | 'unified_memory' | 'system_memory_only' | 'too_large' | 'memory_unknown' | 'benchmark' | 'benchmark_uncalibrated';

export type FitEstimate = { status: FitStatus; basis: 'estimate' | 'benchmark'; reason: FitReason };

/** The memory facts fit needs. Both the client (full report) and the server (minimized report) can supply them. */
export type MemoryFacts = { ramBytes: number | null; gpuFamily: string | null; vramBytes: number | null; unified: boolean };

export function memoryFacts(hw: HardwareReport): MemoryFacts {
  const gpu = bestGpu(hw);
  const dedicated = gpu && (gpu.vendor === 'nvidia' || gpu.vendor === 'amd') && gpu.memory === 'dedicated';
  return {
    ramBytes: hw.ramBytes,
    gpuFamily: gpu?.vendor ?? null,
    vramBytes: dedicated ? gpu.vramBytes : null,
    unified: Boolean(gpu && gpu.memory === 'unified'),
  };
}

export function estimateFit(sizeBytes: number, m: MemoryFacts): FitEstimate {
  const est = (status: FitStatus, reason: FitReason): FitEstimate => ({ status, basis: 'estimate', reason });
  if (m.unified) {
    if (m.ramBytes === null) return est('unknown', 'memory_unknown');
    return sizeBytes <= m.ramBytes ? est('runs_well', 'unified_memory') : est('will_not_fit', 'too_large');
  }
  if (m.vramBytes !== null && sizeBytes <= m.vramBytes) return est('runs_well', 'gpu_memory');
  if (m.ramBytes === null) return est('unknown', 'memory_unknown');
  // Larger than GPU memory (or no GPU): the runtime falls back to system memory and the CPU.
  return sizeBytes <= m.ramBytes ? est('runs_slowly', 'system_memory_only') : est('will_not_fit', 'too_large');
}

export const fitReasonText: Record<FitReason, string> = {
  gpu_memory: 'The download is smaller than this GPU\'s memory.',
  unified_memory: 'The download is smaller than this computer\'s unified memory.',
  system_memory_only: 'Larger than GPU memory, so it would run from system memory.',
  too_large: 'Larger than the memory on this computer.',
  memory_unknown: 'Memory could not be measured on this computer.',
  benchmark: 'Measured on this computer.',
  benchmark_uncalibrated: 'Measured on this computer.',
};

/** Per-runtime speed thresholds, stored with a catalog version on the server (SPEC 5.4). */
export const fitCalibrationSchema = z.object({
  runtime: z.enum(['ollama', 'llama_cpp']),
  catalogVersion: z.number().int().nonnegative(),
  runsWellMinTps: z.number().positive(),
  runsSlowlyMinTps: z.number().positive(),
});
export type FitCalibration = z.infer<typeof fitCalibrationSchema>;

export function fitFromBenchmark(tps: number, estimate: FitEstimate, calibration: FitCalibration | null): FitEstimate {
  if (!calibration) return { status: estimate.status, basis: 'estimate', reason: 'benchmark_uncalibrated' };
  const status: FitStatus = tps >= calibration.runsWellMinTps ? 'runs_well' : tps >= calibration.runsSlowlyMinTps ? 'runs_slowly' : 'will_not_fit';
  return { status, basis: 'benchmark', reason: 'benchmark' };
}

export type StarterCandidate = { slug: string; contentHash: string; sizeBytes: number; acceptedSwarms: readonly string[] };

/**
 * Starter model for a cause (SPEC 5.1 step 5): accepted by the swarm, fits this machine, and the
 * smallest download among the best fit. Nothing is installed by recommending.
 */
export function recommendStarter<T extends StarterCandidate>(candidates: readonly T[], swarm: string, m: MemoryFacts): (T & { fit: FitEstimate }) | null {
  const rank: Record<FitStatus, number> = { runs_well: 0, runs_slowly: 1, unknown: 2, will_not_fit: 3 };
  const fitted = candidates
    .filter((c) => c.acceptedSwarms.includes(swarm))
    .map((c) => ({ ...c, fit: estimateFit(c.sizeBytes, m) }))
    .filter((c) => c.fit.status !== 'will_not_fit')
    .sort((a, b) => rank[a.fit.status] - rank[b.fit.status] || a.sizeBytes - b.sizeBytes);
  return fitted[0] ?? null;
}
