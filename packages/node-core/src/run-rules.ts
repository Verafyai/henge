/**
 * Run rules (SPEC 7.2) and what each platform can actually enforce. Defaults are exactly the
 * spec's. A rule we cannot measure or enforce is reported as best effort or unavailable and must
 * never be shown as guaranteed.
 */
import { z } from 'zod';

export const enforcementSchema = z.enum(['enforced', 'best_effort', 'unavailable']);
export type Enforcement = z.infer<typeof enforcementSchema>;

export const runRulesSchema = z.object({
  when: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('always') }),
    z.object({ kind: z.literal('idle'), idleMinutes: z.number().int().min(1).max(240) }),
    z.object({ kind: z.literal('schedule'), windows: z.array(z.object({ days: z.array(z.number().int().min(0).max(6)).min(1), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })).min(1).max(14) }),
  ]),
  power: z.enum(['any', 'plugged_in']),
  network: z.enum(['any', 'not_metered']),
  thermalCeilingC: z.number().int().min(40).max(110),
  maxLoadPct: z.number().int().min(5).max(100),
  pauseForHeavyApps: z.boolean(),
});
export type RunRules = z.infer<typeof runRulesSchema>;

/** SPEC 7.2 defaults. Heavy-app pause is "configurable" with no stated default, so it starts off. */
export const DEFAULT_RUN_RULES: RunRules = {
  when: { kind: 'idle', idleMinutes: 5 },
  power: 'plugged_in',
  network: 'not_metered',
  thermalCeilingC: 80,
  maxLoadPct: 75,
  pauseForHeavyApps: false,
};

export const enforcementSupportSchema = z.object({
  idle: enforcementSchema,
  schedule: enforcementSchema,
  power: enforcementSchema,
  meteredNetwork: enforcementSchema,
  temperature: enforcementSchema,
  cpuLoad: enforcementSchema,
  gpuLoad: enforcementSchema,
  heavyApp: enforcementSchema,
});
export type EnforcementSupport = z.infer<typeof enforcementSupportSchema>;

/**
 * Based on what the desktop shell can observe today: Electron's powerMonitor gives system idle
 * time everywhere and battery state on macOS and Windows; macOS reports a coarse thermal state,
 * not degrees. Nothing we ship reads metered networks, GPU load or heavy-app signals yet.
 */
export function enforcementSupport(platform: string): EnforcementSupport {
  return {
    idle: 'enforced',
    schedule: 'enforced',
    power: platform === 'darwin' || platform === 'win32' ? 'enforced' : 'best_effort',
    meteredNetwork: 'unavailable',
    temperature: platform === 'darwin' ? 'best_effort' : 'unavailable',
    cpuLoad: 'best_effort',
    gpuLoad: 'unavailable',
    heavyApp: 'unavailable',
  };
}

export const enforcementLabel: Record<Enforcement, string> = {
  enforced: 'Enforced',
  best_effort: 'Best effort',
  unavailable: 'Not available on this computer',
};

/** Plain-language lines for the first-run summary (SPEC 5.1 step 6). */
export function describeRunRules(r: RunRules, s: EnforcementSupport): Array<{ rule: string; value: string; enforcement: Enforcement }> {
  const when = r.when.kind === 'always' ? 'Always' : r.when.kind === 'idle' ? `Only when idle for ${r.when.idleMinutes} minutes` : 'On a schedule';
  return [
    { rule: 'When', value: when, enforcement: r.when.kind === 'schedule' ? s.schedule : r.when.kind === 'idle' ? s.idle : 'enforced' },
    { rule: 'Power', value: r.power === 'plugged_in' ? 'Only when plugged in' : 'On battery too', enforcement: r.power === 'any' ? 'enforced' : s.power },
    { rule: 'Network', value: r.network === 'not_metered' ? 'Not on metered connections' : 'Any connection', enforcement: r.network === 'any' ? 'enforced' : s.meteredNetwork },
    { rule: 'Temperature', value: `Throttle above ${r.thermalCeilingC} °C`, enforcement: s.temperature },
    { rule: 'Load', value: `Up to ${r.maxLoadPct}% of CPU or GPU`, enforcement: s.cpuLoad === 'unavailable' && s.gpuLoad === 'unavailable' ? 'unavailable' : 'best_effort' },
    { rule: 'Heavy apps', value: r.pauseForHeavyApps ? 'Pause when a game or heavy app starts' : 'Off', enforcement: r.pauseForHeavyApps ? s.heavyApp : 'enforced' },
  ];
}
