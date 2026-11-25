/**
 * Mode recommendation (SPEC 3.1 step 3, 5.1 step 3, 5.2). Local is preselected when a usable GPU or
 * Apple Silicon is present. API and Hybrid stay off until each provider clears the terms review
 * (SPEC 5.5), which is a flag per provider and off by default.
 */
import type { Gpu, HardwareReport } from './hardware';

export type Mode = 'local' | 'api' | 'hybrid';
export const API_PROVIDERS = ['openrouter', 'anthropic', 'openai', 'xai'] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];

export type LocalReason = 'apple_silicon' | 'gpu' | 'no_supported_gpu' | 'gpu_memory_unknown' | 'gpu_too_small';

export type ModeOption = { mode: Mode; available: boolean; reason: string };

export type Recommendation = {
  preselect: Mode | null;
  local: { usable: boolean; reason: LocalReason; gpu: Gpu | null };
  options: ModeOption[];
};

/** The GPU we would run on: Apple first, then the discrete card with the most known memory. */
export function bestGpu(hw: HardwareReport): Gpu | null {
  const apple = hw.gpus.find((g) => g.vendor === 'apple');
  if (apple) return apple;
  const discrete = hw.gpus.filter((g) => (g.vendor === 'nvidia' || g.vendor === 'amd') && g.memory !== 'shared');
  return discrete.sort((a, b) => (b.vramBytes ?? -1) - (a.vramBytes ?? -1))[0] ?? hw.gpus[0] ?? null;
}

/**
 * `minVramBytes` is the smallest catalog artifact the node could run, when the catalog is known.
 * We do not invent a VRAM threshold of our own (SPEC 5.4); without the catalog any measured
 * dedicated memory counts, and the fit check in M2 decides what actually runs well.
 */
export function recommendMode(hw: HardwareReport, opts: { minVramBytes?: number | null; enabledProviders?: readonly ApiProvider[] } = {}): Recommendation {
  const gpu = bestGpu(hw);
  let reason: LocalReason;
  if (hw.cpu.appleSilicon) reason = 'apple_silicon';
  else if (!gpu || (gpu.vendor !== 'nvidia' && gpu.vendor !== 'amd') || gpu.memory === 'shared') reason = 'no_supported_gpu';
  else if (gpu.vramBytes === null) reason = 'gpu_memory_unknown';
  else if (opts.minVramBytes && gpu.vramBytes < opts.minVramBytes && gpu.vramConfidence === 'measured') reason = 'gpu_too_small';
  else reason = 'gpu';
  const usable = reason === 'apple_silicon' || reason === 'gpu';

  const providers = opts.enabledProviders ?? [];
  const apiReason = providers.length ? `Available for ${providers.join(', ')}. Real provider charges apply.` : 'Off until provider terms are reviewed. Local mode is the default.';
  return {
    preselect: usable ? 'local' : null,
    local: { usable, reason, gpu: hw.cpu.appleSilicon ? (gpu ?? null) : gpu },
    options: [
      { mode: 'local', available: true, reason: localReasonText(reason) },
      { mode: 'api', available: providers.length > 0, reason: apiReason },
      { mode: 'hybrid', available: providers.length > 0, reason: providers.length ? 'Local first; API only for policy-required work you approve per swarm.' : apiReason },
    ],
  };
}

export function localReasonText(r: LocalReason): string {
  switch (r) {
    case 'apple_silicon':
      return 'Apple Silicon detected. Local models run on its unified memory.';
    case 'gpu':
      return 'A supported GPU was detected.';
    case 'no_supported_gpu':
      return 'No supported GPU was detected. Local models can still run on the CPU, slowly.';
    case 'gpu_memory_unknown':
      return 'A GPU was found but its memory could not be measured. Fit is checked before any download.';
    case 'gpu_too_small':
      return 'The GPU has less memory than the smallest catalog model. Local models would run on the CPU, slowly.';
  }
}

export type CauseFit =
  | { status: 'ready'; message: string }
  | { status: 'cpu_only'; message: string }
  | { status: 'policy_mismatch'; message: string };

/**
 * Can this node take part in a swarm at all? `acceptedLocalModels` are the catalog models whose
 * accepted swarms include it. The detailed fit per model is M2.
 */
export function causeFit(rec: Recommendation, swarm: { apiAllowed: boolean }, acceptedLocalModels: number): CauseFit {
  const apiOn = rec.options.some((o) => o.mode === 'api' && o.available);
  if (acceptedLocalModels === 0) {
    if (swarm.apiAllowed && apiOn) return { status: 'ready', message: 'No local model qualifies, but your API setup can.' };
    return {
      status: 'policy_mismatch',
      message: swarm.apiAllowed
        ? 'No local catalog model qualifies for this swarm, and API setup is not available yet. Pick another swarm.'
        : 'No local catalog model qualifies for this swarm yet. Pick another swarm.',
    };
  }
  if (!rec.local.usable) return { status: 'cpu_only', message: `${localReasonText(rec.local.reason)} You can continue or pick another swarm.` };
  return { status: 'ready', message: 'This computer can run a qualifying local model. Fit is confirmed before any download.' };
}
