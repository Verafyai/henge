import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalDigest,
  fixtureJuryAdapter,
  juryVerifier,
  knownAnswersVerifier,
  recordPayload,
  redundancyVerdicts,
  signingKeyFromPkcs8,
  signRecord,
  splitSignature,
  verificationRecordMessage,
  verifySignature,
  type JurorVerdict,
  type Verdict,
} from './index';

describe('known answers (SPEC 8.1)', () => {
  it('compares hidden known answers and never puts the answer in the evidence', () => {
    const expected = { reproduced: false };
    const good = knownAnswersVerifier.verify({ kind: 'known', expected, output: { reproduced: false, attack: null } }) as Verdict;
    const bad = knownAnswersVerifier.verify({ kind: 'known', expected, output: { reproduced: true, attack: 'x' } }) as Verdict;
    expect(good).toMatchObject({ outcome: 'accepted', rationaleCode: 'known_answer_match' });
    expect(bad).toMatchObject({ outcome: 'rejected', rationaleCode: 'known_answer_mismatch' });
    expect(JSON.stringify(bad)).not.toContain('reproduced');
    expect(bad.evidenceHashes).toEqual([canonicalDigest(expected)]);
  });

  it('accepts ordinary work only from nodes with no failed known answer; flagged nodes wait for review', () => {
    expect(knownAnswersVerifier.verify({ kind: 'ordinary', nodeFlagged: false })).toMatchObject({ outcome: 'accepted' });
    expect(knownAnswersVerifier.verify({ kind: 'ordinary', nodeFlagged: true })).toBeNull();
  });
});

describe('redundancy (SPEC 8.1, 8.3)', () => {
  const sub = (resultId: string, accountId: string, outputHash: string, nodeId = `n-${resultId}`) => ({ resultId, accountId, nodeId, outputHash });

  it('decides nothing without a configured count, and nothing until enough independent accounts answered', () => {
    expect(redundancyVerdicts([sub('a', 'A', 'h1'), sub('b', 'B', 'h1')], null)).toBeNull();
    // Two nodes of one account count once.
    expect(redundancyVerdicts([sub('a', 'A', 'h1'), sub('b', 'A', 'h1')], 2)).toBeNull();
  });

  it('accepts the strict-majority answer and rejects the rest', () => {
    const v = redundancyVerdicts([sub('a', 'A', 'h1'), sub('b', 'B', 'h1'), sub('c', 'C', 'h2')], 3)!;
    expect(v.get('a')!.outcome).toBe('accepted');
    expect(v.get('b')!.outcome).toBe('accepted');
    expect(v.get('c')).toMatchObject({ outcome: 'rejected', rationaleCode: 'redundancy_disagreed' });
  });

  it('same-account nodes never count as independent: the second node of an account is not counted', () => {
    const v = redundancyVerdicts([sub('a', 'A', 'h1'), sub('a2', 'A', 'h1'), sub('b', 'B', 'h2'), sub('c', 'C', 'h2')], 3)!;
    expect(v.get('a2')).toMatchObject({ outcome: 'rejected', rationaleCode: 'not_counted' });
    expect(v.get('b')!.outcome).toBe('accepted');
    expect(v.get('a')).toMatchObject({ outcome: 'rejected', rationaleCode: 'redundancy_disagreed' });
  });

  it('rejects every answer when no strict majority agrees', () => {
    const v = redundancyVerdicts([sub('a', 'A', 'h1'), sub('b', 'B', 'h2')], 2)!;
    expect([...v.values()].map((x) => x.rationaleCode)).toEqual(['redundancy_no_majority', 'redundancy_no_majority']);
  });
});

describe('jury adapter (SPEC 8.1, 8.3)', () => {
  const submitter = { accountId: 'S', nodeId: 'sn' };
  const j = (acct: string, family: string, verdict: 'accept' | 'reject', node = `${acct}-node`): JurorVerdict => ({ jurorAccountId: acct, jurorNodeId: node, modelFamily: family, verdict, rationaleCode: 'cites_rule' });
  const subject = { resultId: 'r', taskKey: 'dispute-1', outputHash: 'h', submitter };

  it('a juror can never grade its own submission, and one account holds one seat', async () => {
    const adapter = fixtureJuryAdapter({ 'dispute-1': [j('S', 'llama', 'accept'), j('X', 'qwen', 'accept', 'sn'), j('A', 'llama', 'accept'), j('A', 'mistral', 'accept'), j('B', 'qwen', 'reject')] });
    const verdicts = (await adapter.verdictsFor(subject))!;
    // Only A and B are eligible: not enough for a panel of 3.
    expect(juryVerifier.verify({ subject, verdicts, panelSize: 3, minFamilies: null })).toBeNull();
    const ruled = juryVerifier.verify({ subject, verdicts: [...verdicts, j('C', 'gemma', 'accept')], panelSize: 3, minFamilies: 3 }) as Verdict;
    expect(ruled).toMatchObject({ outcome: 'accepted', rationaleCode: 'jury_accepted' });
    expect(ruled.panel).toMatchObject({ excluded_self: 2, families: 3 });
    expect((ruled.panel!['jurors'] as Array<{ account: string }>).map((p) => p.account)).toEqual(['A', 'B', 'C']);
  });

  it('waits without a configured panel size or enough model families; a majority of rejects rejects', () => {
    const verdicts = [j('A', 'llama', 'reject'), j('B', 'llama', 'reject'), j('C', 'qwen', 'accept')];
    expect(juryVerifier.verify({ subject, verdicts, panelSize: null, minFamilies: null })).toBeNull();
    expect(juryVerifier.verify({ subject, verdicts, panelSize: 3, minFamilies: 3 })).toBeNull();
    expect(juryVerifier.verify({ subject, verdicts, panelSize: 3, minFamilies: 2 })).toMatchObject({ outcome: 'rejected' });
  });
});

describe('signed verification records (SPEC 8.2)', () => {
  it('signs over the canonical record and refuses any change', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const key = signingKeyFromPkcs8('k1', privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'));
    const p = recordPayload({ type: 'result', id: 'r1' }, 'machine-check', 'sha256-aa', { outcome: 'accepted', rationaleCode: 'ok', evidenceHashes: ['sha256-bb'], verifierVersion: 'v1' });
    const s = splitSignature(signRecord(key, p))!;
    expect(s.keyId).toBe('k1');
    expect(verifySignature(key.publicKey, verificationRecordMessage(p), s.signature)).toBe(true);
    expect(verifySignature(key.publicKey, verificationRecordMessage({ ...p, outcome: 'rejected' }), s.signature)).toBe(false);
    expect(splitSignature('nokey')).toBeNull();
  });
});
