export * from './records';
export * from './methods';

/**
 * Which machine checker verifies a swarm's results, by harness name. Machine checks run in the
 * verifier worker, never in a web function (Lean needs a real process).
 */
export const MACHINE_CHECKERS: Record<string, 'lean' | 'prompt-guard-reproduction'> = {
  'lean-prover': 'lean',
  'prompt-guard-red-team': 'prompt-guard-reproduction',
};
export type MachineChecker = (typeof MACHINE_CHECKERS)[string];
