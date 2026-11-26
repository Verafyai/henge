/**
 * Coordinator-side verifiers that need no external tools (SPEC 8.1): known answers, redundancy and
 * the jury adapter. Each implements the same Verifier interface. Anti-cheat rules (SPEC 8.3) live
 * here too: a node or account never grades its own work, and nodes of one account never count as
 * independent.
 */
import { canonicalJson } from '@swarm-explorer/schema';
import { canonicalDigest, type Verdict, type Verifier } from './records';

/* ----------------------------------------------------------------------------
 * Known answers
 * ------------------------------------------------------------------------- */

export const KNOWN_ANSWERS_VERSION = 'known-answers-v1';

/** True when every expected field matches the output exactly under canonical JSON. */
export function matchesExpected(expected: Record<string, unknown>, output: unknown): boolean {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const o = output as Record<string, unknown>;
  return Object.entries(expected).every(([k, v]) => k in o && canonicalJson(o[k]) === canonicalJson(v));
}

export type KnownAnswerInput =
  /** A hidden known-answer task: compare the output with the expected fields. */
  | { kind: 'known'; expected: Record<string, unknown>; output: unknown }
  /** Ordinary work in a known-answers swarm: accepted unless this node has a failed known answer. */
  | { kind: 'ordinary'; nodeFlagged: boolean };

/**
 * Known answers (SPEC 8.1). The evidence is a hash of the expected fields, never the fields
 * themselves, so the record does not disclose the hidden answer (SPEC 8.2). A node with a failed
 * known answer is flagged: its ordinary results wait in Verifying for review instead of being
 * accepted (null).
 */
export const knownAnswersVerifier: Verifier<KnownAnswerInput> = {
  method: 'known-answers',
  version: KNOWN_ANSWERS_VERSION,
  verify(i): Verdict | null {
    if (i.kind === 'ordinary') {
      if (i.nodeFlagged) return null;
      return { outcome: 'accepted', rationaleCode: 'no_known_answer_flags', evidenceHashes: [], verifierVersion: KNOWN_ANSWERS_VERSION };
    }
    const ok = matchesExpected(i.expected, i.output);
    return { outcome: ok ? 'accepted' : 'rejected', rationaleCode: ok ? 'known_answer_match' : 'known_answer_mismatch', evidenceHashes: [canonicalDigest(i.expected)], verifierVersion: KNOWN_ANSWERS_VERSION };
  },
};

/* ----------------------------------------------------------------------------
 * Redundancy
 * ------------------------------------------------------------------------- */

export const REDUNDANCY_VERSION = 'redundancy-v1';

export type RedundancySubmission = { resultId: string; accountId: string; nodeId: string; outputHash: string };

/**
 * Redundancy (SPEC 8.1): the same task went to `required` independent nodes. Independence is by
 * account: several nodes of one account count once, and only that account's first submission counts.
 * Nothing is decided until `required` distinct accounts have answered. Answers are compatible when
 * their canonical output hashes are equal; the hash that a strict majority of accounts gave is
 * accepted, everything else is rejected. With no strict majority, every answer is rejected.
 * Returns a verdict per result id, or null while the group is incomplete.
 */
export function redundancyVerdicts(subs: RedundancySubmission[], required: number | null): Map<string, Verdict> | null {
  if (required === null || required < 2) return null;
  const firstByAccount = new Map<string, RedundancySubmission>();
  for (const s of subs) if (!firstByAccount.has(s.accountId)) firstByAccount.set(s.accountId, s);
  const independent = [...firstByAccount.values()];
  if (independent.length < required) return null;
  const counted = independent.slice(0, required);
  const tally = new Map<string, number>();
  for (const s of counted) tally.set(s.outputHash, (tally.get(s.outputHash) ?? 0) + 1);
  const [winner, votes] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const majority = votes * 2 > counted.length ? winner : null;
  const panel = { required, accounts: counted.map((s) => s.accountId), hashes: counted.map((s) => s.outputHash), agreeing: majority ? votes : 0 };
  const evidence = [canonicalDigest(panel)];
  const out = new Map<string, Verdict>();
  for (const s of subs) {
    const isCounted = counted.includes(s);
    const ok = majority !== null && isCounted && s.outputHash === majority;
    out.set(s.resultId, {
      outcome: ok ? 'accepted' : 'rejected',
      rationaleCode: ok ? 'redundancy_agreed' : !isCounted ? 'not_counted' : majority ? 'redundancy_disagreed' : 'redundancy_no_majority',
      evidenceHashes: evidence,
      verifierVersion: REDUNDANCY_VERSION,
      panel,
    });
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * Jury adapter
 * ------------------------------------------------------------------------- */

export const JURY_VERSION = 'jury-adapter-v1';

export type JurorVerdict = { jurorAccountId: string; jurorNodeId: string; modelFamily: string; verdict: 'accept' | 'reject'; rationaleCode: string };

export type JurySubject = { resultId: string; taskKey: string; outputHash: string; submitter: { accountId: string; nodeId: string } };

/** Where juror verdicts come from. Real panels come with the communities work; tests use fixtures. */
export interface JuryAdapter {
  readonly name: string;
  verdictsFor(subject: JurySubject): Promise<JurorVerdict[] | null>;
}

/** Fixture-driven panels keyed by task key (the coordinator task id). */
export function fixtureJuryAdapter(panels: Record<string, JurorVerdict[]>): JuryAdapter {
  return { name: 'fixture', verdictsFor: async (s) => panels[s.taskKey] ?? null };
}

export type JuryInput = { subject: JurySubject; verdicts: JurorVerdict[]; panelSize: number | null; minFamilies: number | null };

/**
 * Jury (SPEC 8.1, 8.3): the submitter's own account and node never sit on its panel, and one account
 * holds at most one seat. A ruling needs `panelSize` seats from at least `minFamilies` model families;
 * until then it waits (null). A strict majority of accept verdicts accepts.
 */
export const juryVerifier: Verifier<JuryInput> = {
  method: 'jury',
  version: JURY_VERSION,
  verify({ subject, verdicts, panelSize, minFamilies }): Verdict | null {
    if (panelSize === null) return null;
    const seats = new Map<string, JurorVerdict>();
    let excludedSelf = 0;
    for (const v of verdicts) {
      if (v.jurorAccountId === subject.submitter.accountId || v.jurorNodeId === subject.submitter.nodeId) {
        excludedSelf++;
        continue;
      }
      if (!seats.has(v.jurorAccountId)) seats.set(v.jurorAccountId, v);
    }
    const panel = [...seats.values()].slice(0, panelSize);
    if (panel.length < panelSize) return null;
    const families = new Set(panel.map((p) => p.modelFamily));
    if (minFamilies !== null && families.size < minFamilies) return null;
    const accepts = panel.filter((p) => p.verdict === 'accept').length;
    const ok = accepts * 2 > panel.length;
    const panelJson = { panel_size: panelSize, jurors: panel.map((p) => ({ account: p.jurorAccountId, node: p.jurorNodeId, family: p.modelFamily, verdict: p.verdict })), families: families.size, excluded_self: excludedSelf };
    return { outcome: ok ? 'accepted' : 'rejected', rationaleCode: ok ? 'jury_accepted' : 'jury_rejected', evidenceHashes: [canonicalDigest(panelJson)], verifierVersion: JURY_VERSION, panel: panelJson };
  },
};
