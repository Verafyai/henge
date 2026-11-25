/**
 * Signed bundle verification (SPEC 6.1, 11.6). A node refuses unsigned, tampered, revoked or
 * unreviewed bundles. All checks run before the module is even compiled:
 *
 * 1. the release is reviewed and not revoked, and its publisher key is active and not revoked;
 * 2. the release signature verifies over {publisher, name, version, bundle_hash};
 * 3. the directory's content address equals the signed bundle hash;
 * 4. harness.json parses strictly and names files inside the bundle.
 */
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, validateHarnessBundle } from '@swarm-explorer/schema';
import { bundleDigest, type RegisteredKey } from '@swarm-explorer/schema/node';
import { z } from 'zod';

/** Typed view of harness.json; the JSON Schema in @swarm-explorer/schema is the strict check. */
export const harnessJsonSchema = z
  .object({
    harness_version: z.literal(1),
    name: z.string(),
    version: z.string(),
    runtime: z.enum(['wasm', 'container']),
    entry: z.string(),
    system_prompt: z.string(),
    tools: z.array(z.unknown()),
    loop: z.object({ max_steps: z.number().int().positive(), retries: z.number().int().nonnegative(), step_timeout_s: z.number().positive(), total_timeout_s: z.number().positive() }),
    output_schema: z.string(),
    min_model_class: z.string(),
    capabilities: z.array(z.enum(['model.complete', 'scratch.read', 'scratch.write', 'network.fetch', 'checker.run'])),
    limits: z.object({ memory_mb: z.number().int().positive(), cpu_ms: z.number().int().positive(), wall_s: z.number().positive(), scratch_mb: z.number().int().nonnegative(), processes: z.number().int().positive() }),
  })
  .loose();
export type HarnessJson = z.infer<typeof harnessJsonSchema>;

/** Bundle-relative file paths must stay inside the bundle. */
function inside(p: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(p) && !p.split('/').includes('..');
}

export type ReleaseClaim = {
  publisher: string;
  name: string;
  version: string;
  bundleHash: string;
  /** `keyId:base64signature`, as stored on harness_releases. */
  signature: string;
  reviewed: boolean;
  revoked: boolean;
};

export type Revoked = { harnessReleases: ReadonlySet<string>; publisherKeys: ReadonlySet<string> };

export type VerifiedBundle = {
  dir: string;
  harness: HarnessJson;
  bundleHash: string;
  keyId: string;
  wasm: Uint8Array | null;
  systemPrompt: string;
  outputSchema: unknown;
};

export type BundleCheck = { ok: true; bundle: VerifiedBundle } | { ok: false; reason: 'unreviewed' | 'revoked' | 'unsigned' | 'unknown_key' | 'revoked_key' | 'wrong_publisher' | 'bad_signature' | 'tampered' | 'bad_harness_json' | 'mismatched_release' };

export function releaseSigningPayload(r: Pick<ReleaseClaim, 'publisher' | 'name' | 'version' | 'bundleHash'>): string {
  return canonicalJson({ publisher: r.publisher, name: r.name, version: r.version, bundle_hash: r.bundleHash });
}

export function verifyBundle(dir: string, release: ReleaseClaim, lookup: (keyId: string) => RegisteredKey | undefined, revoked: Revoked): BundleCheck {
  if (!release.reviewed) return { ok: false, reason: 'unreviewed' };
  if (release.revoked || revoked.harnessReleases.has(`${release.name}@${release.version}`) || revoked.harnessReleases.has(release.bundleHash)) return { ok: false, reason: 'revoked' };
  const m = /^([^:]{1,120}):([A-Za-z0-9+/=]{40,200})$/.exec(release.signature);
  if (!m) return { ok: false, reason: 'unsigned' };
  const key = lookup(m[1]!);
  if (!key) return { ok: false, reason: 'unknown_key' };
  if (key.status !== 'active' || revoked.publisherKeys.has(key.keyId)) return { ok: false, reason: 'revoked_key' };
  if (key.publisher !== release.publisher) return { ok: false, reason: 'wrong_publisher' };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(releaseSigningPayload(release)), createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(m[2]!, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: 'bad_signature' };

  let digest: string;
  try {
    digest = bundleDigest(dir);
  } catch {
    return { ok: false, reason: 'tampered' };
  }
  if (digest !== release.bundleHash) return { ok: false, reason: 'tampered' };

  let harness: HarnessJson;
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, 'harness.json'), 'utf8'));
    if (validateHarnessBundle(raw).length) return { ok: false, reason: 'bad_harness_json' };
    const parsed = harnessJsonSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'bad_harness_json' };
    harness = parsed.data;
  } catch {
    return { ok: false, reason: 'bad_harness_json' };
  }
  if (harness.name !== release.name || harness.version !== release.version) return { ok: false, reason: 'mismatched_release' };
  if (![harness.system_prompt, harness.output_schema, ...(harness.runtime === 'wasm' ? [harness.entry] : [])].every(inside)) return { ok: false, reason: 'bad_harness_json' };
  const read = (p: string) => readFileSync(path.join(dir, ...p.split('/')));
  try {
    return {
      ok: true,
      bundle: {
        dir,
        harness,
        bundleHash: digest,
        keyId: key.keyId,
        wasm: harness.runtime === 'wasm' ? new Uint8Array(read(harness.entry)) : null,
        systemPrompt: read(harness.system_prompt).toString('utf8'),
        outputSchema: JSON.parse(read(harness.output_schema).toString('utf8')),
      },
    };
  } catch {
    return { ok: false, reason: 'bad_harness_json' };
  }
}
