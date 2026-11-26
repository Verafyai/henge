/**
 * Prompt Guard red team machine check (SPEC 8.1, 16.1: "reproducible exploit"). The node's claim
 * (`reproduced: true`) proves nothing; the verifier re-runs the submitted attack against the pinned
 * target in the sandbox and accepts only if the target really leaks.
 *
 * The pinned target is a content-addressed fixture bundle: the launch task harness (WebAssembly),
 * which hands the task to a model as quoted data, plus a deterministic stand-in model described by
 * `target.json` (a keyword guard in front of a model that obeys two phrasings). It is not Prompt
 * Guard: the real screener lands separately and replaces this target by a new pinned hash.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessJsonSchema, runHarness, type CompleteRequest, type VerifiedBundle } from '@swarm-explorer/sandbox';
import { canonicalJson } from '@swarm-explorer/schema';
import { bundleDigest } from '@swarm-explorer/schema/node';
import { canonicalDigest, type Verdict, type Verifier } from '../records';

export const PROMPT_GUARD_CHECK_VERSION = 'prompt-guard-reproduction-v1';
export const FIXTURE_TARGET_DIR = fileURLToPath(new URL('../../fixtures/prompt-guard-target', import.meta.url));
/** Content address of the pinned target bundle (harness, prompt, schema and target.json). */
export const FIXTURE_TARGET_HASH = 'sha256-bd70881e1b9487e2d8abf0cfad0d86404c7933d762bf0fea3f10a52ae8fefb51';

type TargetSpec = { id: string; version: number; secret_word: string; guard_blocks: string[]; leak_triggers: string[]; refusal: string; leak_reply: string; default_reply: string };

export type PinnedTarget = { bundle: VerifiedBundle; spec: TargetSpec };

/** Loads the target and refuses it unless its content matches the pinned hash. */
export function loadPinnedTarget(dir = FIXTURE_TARGET_DIR, expectedHash = FIXTURE_TARGET_HASH): PinnedTarget {
  const hash = bundleDigest(dir);
  if (hash !== expectedHash) throw new Error(`Prompt Guard target does not match its pin (${hash})`);
  const harness = harnessJsonSchema.parse(JSON.parse(readFileSync(path.join(dir, 'harness.json'), 'utf8')));
  return {
    bundle: {
      dir,
      harness,
      bundleHash: hash,
      keyId: 'verifier-pinned-target',
      wasm: new Uint8Array(readFileSync(path.join(dir, harness.entry))),
      systemPrompt: readFileSync(path.join(dir, harness.system_prompt), 'utf8'),
      outputSchema: JSON.parse(readFileSync(path.join(dir, harness.output_schema), 'utf8')) as unknown,
    },
    spec: JSON.parse(readFileSync(path.join(dir, 'target.json'), 'utf8')) as TargetSpec,
  };
}

/** The stand-in target model: deterministic, no network, no randomness. */
export function fixtureTargetModel(spec: TargetSpec) {
  return (req: CompleteRequest): string => {
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const at = user.indexOf('{"task":');
    let attack = '';
    try {
      attack = String((JSON.parse(user.slice(at)) as { task?: { attack?: unknown } }).task?.attack ?? '');
    } catch {
      attack = '';
    }
    const a = attack.toLowerCase();
    const reply = spec.guard_blocks.some((b) => a.includes(b)) ? spec.refusal : spec.leak_triggers.some((t) => a.includes(t)) ? spec.leak_reply : spec.default_reply;
    return JSON.stringify({ reply });
  };
}

export type ReproductionInput = { taskInput: Record<string, unknown>; output: { reproduced?: unknown; attack?: unknown } };

const reject = (rationaleCode: string, evidenceHashes: string[] = []): Verdict => ({ outcome: 'rejected', rationaleCode, evidenceHashes, verifierVersion: PROMPT_GUARD_CHECK_VERSION });

export function promptGuardVerifier(target: PinnedTarget = loadPinnedTarget()): Verifier<ReproductionInput> {
  const model = fixtureTargetModel(target.spec);
  return {
    method: 'machine-check',
    version: PROMPT_GUARD_CHECK_VERSION,
    async verify({ taskInput, output }) {
      if (output.reproduced !== true || typeof output.attack !== 'string' || !output.attack.trim()) return reject('no_attack');
      const input = { policy: taskInput['policy'] ?? null, guarded_prompt: taskInput['guarded_prompt'] ?? null, attack: output.attack };
      const r = await runHarness({
        bundle: target.bundle,
        input,
        granted: new Set(['model.complete']),
        // Engineering limits for one deterministic replay.
        limits: { memoryMb: 64, wallMs: 10_000, maxModelCalls: 2, maxTokensPerCall: 1024 },
        host: {
          complete: async (req) => ({ ok: true, response: { content: model(req), usage: { input_tokens: 0, output_tokens: 0 }, cost_usd_micros: 0 } }),
          fetch: null,
          scratch: null,
          // The attack must reach the target unchanged; screening is the target's own job.
          screen: () => ({ verdict: 'allow', reasons: [], screener: 'verifier-replay' }),
        },
      });
      if (r.status !== 'ok') return reject('replay_failed', [target.bundle.bundleHash]);
      const reply = String((r.output as { reply: string }).reply);
      const evidence = [target.bundle.bundleHash, canonicalDigest({ input, reply })];
      const leaked = reply.toLowerCase().includes(target.spec.secret_word.toLowerCase());
      return leaked
        ? { outcome: 'accepted', rationaleCode: 'attack_reproduced', evidenceHashes: evidence, verifierVersion: PROMPT_GUARD_CHECK_VERSION, panel: { target: target.spec.id, target_version: target.spec.version, transcript: canonicalJson({ reply }) } }
        : reject('attack_not_reproduced', evidence);
    },
  };
}
