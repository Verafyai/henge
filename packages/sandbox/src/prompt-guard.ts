import { GUARD_VERSION, scan } from '@swarm-explorer/prompt-guard';
import type { ScreenVerdict, Screener } from './broker';

/** Vendored commit, so every recorded verdict says exactly which Prompt Guard produced it (VENDOR.md). */
export const PROMPT_GUARD_COMMIT = 'caae11c';
export const PROMPT_GUARD_SCREENER = `${GUARD_VERSION}@${PROMPT_GUARD_COMMIT}`;

/** Every string in the task input, with its JSON path, so a flag can say where it was found. */
function strings(value: unknown, path = '$', out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  return out;
}

/**
 * Prompt Guard screening (DECISIONS 2026-11-25; replaces heuristic-v1). Scans every string in the task input for
 * text that addresses the reader: instruction overrides, hidden or encoded instructions, look-alike letters, invisible
 * markup. A suspicious input is flagged and the verdict is recorded. As before, flagged input still runs, because the
 * sandbox's structural protections do not depend on the screen; verifiers and juries see the verdict.
 */
export const promptGuardScreener: Screener = (input): ScreenVerdict => {
  const reasons = new Set<string>();
  for (const [path, text] of strings(input)) {
    const report = scan(text);
    if (!report.suspicious) continue;
    for (const f of report.flags) if (f.rule !== 'lookalike') reasons.add(`${f.rule} at ${path}`);
    if (report.hidden.tag) reasons.add(`hidden-text at ${path}`);
    if (report.hidden.bidi) reasons.add(`bidi-control at ${path}`);
  }
  const list = [...reasons].sort();
  return { verdict: list.length ? 'flag' : 'allow', reasons: list, screener: PROMPT_GUARD_SCREENER };
};
