/**
 * The verifier worker loop (SPEC 8.1). It pulls work from `GET /v1/verifier/work`, runs the checker
 * the swarm's harness names, and posts a signed record to `POST /v1/verifications`. Every request
 * is signed with the worker key; the platform re-checks the record signature and the assignment.
 * A checker that cannot decide (for example no network isolation here) posts nothing, so the
 * subject stays in Verifying for a capable worker.
 */
import { randomBytes, sign } from 'node:crypto';
import { verifierWorkSchema, verificationRecordedSchema, type VerifierWorkItem } from '@swarm-explorer/api-client';
import { bodySha256, recordPayload, signRecord, VERIFIER_HEADERS, verifierRequestMessage, type SigningKey, type Verdict, type Verifier } from '@swarm-explorer/verify';
import type { LeanInput, ReproductionInput } from '@swarm-explorer/verify/worker';

export type Checkers = { lean?: Verifier<LeanInput> | null; 'prompt-guard-reproduction'?: Verifier<ReproductionInput> | null };
export type WorkerOptions = { apiUrl: string; key: SigningKey; checkers: Checkers; fetch?: typeof fetch; log?: (line: string) => void };
export type PassReport = { seen: number; posted: number; undecided: number; failed: number };

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** Maps a work item to its checker's input. Unknown shapes return null and are left alone. */
export function checkerInput(item: VerifierWorkItem): { checker: 'lean'; input: LeanInput } | { checker: 'prompt-guard-reproduction'; input: ReproductionInput } | null {
  if (item.checker === 'lean') {
    const statement = str(item.input['lemma']) ?? str(item.input['statement']);
    if (!statement) return null;
    return { checker: 'lean', input: { statement, header: str(item.input['header']), candidate: { status: str(item.output['status']) ?? '', proof: str(item.output['proof']) } } };
  }
  if (item.checker === 'prompt-guard-reproduction') return { checker: 'prompt-guard-reproduction', input: { taskInput: item.input, output: item.output } };
  return null;
}

export function createWorker(o: WorkerOptions) {
  const doFetch = o.fetch ?? fetch;
  const log = o.log ?? (() => undefined);
  const base = new URL(o.apiUrl);

  async function signedRequest(method: 'GET' | 'POST', path: string, body = '') {
    const ts = Date.now();
    const nonce = randomBytes(16).toString('base64url');
    const msg = verifierRequestMessage({ method, path, bodySha256: bodySha256(body), ts, nonce });
    return doFetch(new URL(path, base), {
      method,
      headers: {
        'content-type': 'application/json',
        [VERIFIER_HEADERS.keyId]: o.key.keyId,
        [VERIFIER_HEADERS.ts]: String(ts),
        [VERIFIER_HEADERS.nonce]: nonce,
        [VERIFIER_HEADERS.signature]: sign(null, Buffer.from(msg), o.key.privateKey).toString('base64url'),
      },
      body: method === 'GET' ? undefined : body,
    });
  }

  async function decide(item: VerifierWorkItem): Promise<Verdict | null> {
    const c = checkerInput(item);
    if (!c) return null;
    if (c.checker === 'lean') return o.checkers.lean ? o.checkers.lean.verify(c.input) : null;
    const pg = o.checkers['prompt-guard-reproduction'];
    return pg ? pg.verify(c.input) : null;
  }

  /** One poll: fetch work, check each item, post each verdict. */
  async function runOnce(limit = 10): Promise<PassReport> {
    const report: PassReport = { seen: 0, posted: 0, undecided: 0, failed: 0 };
    const res = await signedRequest('GET', `/v1/verifier/work?limit=${limit}`);
    if (!res.ok) throw new Error(`verifier work request failed with HTTP ${res.status}`);
    const { items } = verifierWorkSchema.parse(await res.json());
    for (const item of items) {
      report.seen++;
      let verdict: Verdict | null;
      try {
        verdict = await decide(item);
      } catch (e) {
        report.failed++;
        log(`check failed for ${item.subject.type} ${item.subject.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!verdict) {
        report.undecided++;
        continue;
      }
      const payload = recordPayload(item.subject, 'machine-check', item.output_sha256, verdict);
      const post = await signedRequest('POST', '/v1/verifications', JSON.stringify({ payload, signature: signRecord(o.key, payload) }));
      if (post.ok) {
        verificationRecordedSchema.parse(await post.json());
        report.posted++;
        log(`${item.subject.type} ${item.subject.id}: ${verdict.outcome} (${verdict.rationaleCode})`);
      } else {
        report.failed++;
        log(`posting ${item.subject.id} failed with HTTP ${post.status}`);
      }
    }
    return report;
  }

  return { runOnce, signedRequest };
}
