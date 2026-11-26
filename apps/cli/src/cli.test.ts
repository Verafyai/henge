import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApiClient } from '@swarm-explorer/api-client';
import { signReceipt } from '@swarm-explorer/schema/node';
import { describe, expect, it } from 'vitest';
import { run, type Deps } from './cli';

const FIX = path.resolve(import.meta.dirname, '../../../packages/schema/fixtures/manifests');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const deps = (status: number, body: unknown): Deps => ({
  api: createApiClient({ baseUrl: 'http://x', fetch: async () => new Response(JSON.stringify(body), { status }) }),
  readFile: (p) => readFile(p, 'utf8'),
});

describe('swarm cli', () => {
  it('prints help and version', async () => {
    const c = capture();
    expect(await run(['--version'], c.io, deps(200, {}))).toBe(0);
    expect(c.out).toEqual(['0.1.0']);
    expect(await run([], c.io, deps(200, {}))).toBe(0);
    expect(c.out.at(-1)).toContain('swarm validate');
  });

  it('reports API errors with a nonzero exit', async () => {
    const c = capture();
    expect(await run(['show', 'nope'], c.io, deps(404, { error: { code: 'not_found', message: 'No such swarm' } }))).toBe(1);
    expect(c.err[0]).toContain('not_found');
  });

  it('reserved commands exit 3 with their milestone; unknown ones exit 2', async () => {
    const c = capture();
    expect(await run(['publish'], c.io, deps(200, {}))).toBe(3);
    expect(c.err[0]).toContain('M11');
    expect(await run(['frobnicate'], c.io, deps(200, {}))).toBe(2);
    expect(await run(['swarms', '--category', 'games'], c.io, deps(200, {}))).toBe(2);
  });

  it('lists swarms', async () => {
    const c = capture();
    expect(await run(['swarms'], c.io, deps(200, { items: [] }))).toBe(0);
    expect(c.out.at(-1)).toBe('0 swarms (example data)');
  });

  it('validates manifests from disk', async () => {
    const ok = capture();
    expect(await run(['validate', path.join(FIX, 'valid/challenge-vaults.yaml')], ok.io, deps(200, {}))).toBe(0);
    expect(ok.out[0]).toContain('"challenge-vaults"');
    const bad = capture();
    const tmp = { ...deps(200, {}), readFile: async () => 'manifest_version: 1\nid: x\n' };
    expect(await run(['validate', 'x.yaml'], bad.io, tmp)).toBe(1);
    expect(bad.err.length).toBeGreaterThan(0);
  });

  it('verifies a receipt offline, and checks its key against the platform keys when given', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const key = { keyId: 'receipt-cli-test', privateKey, publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url') };
    const receipt = signReceipt(
      {
        receipt_version: 1,
        receipt_id: '00000000-0000-7000-8000-00000000000a',
        issued_at: '2026-11-25T12:00:00.000Z',
        result: { id: '00000000-0000-7000-8000-00000000000b', state: 'settled', output_sha256: `sha256-${'a'.repeat(64)}` },
        swarm: { slug: 'prompt-guard-red-team', funded: false, release_manifest_hash: `sha256-${'b'.repeat(64)}` },
        pins: { harness: { name: 'prompt-guard-red-team', version: '0.1.0', hash: `sha256-${'c'.repeat(64)}` }, model_artifact_hash: null, permissions_hash: `sha256-${'e'.repeat(64)}` },
        verification: [{ method: 'machine-check', outcome: 'accepted', verifier_version: 'v1', verifier_key_id: 'w' }],
        timeline: { submitted_at: '2026-11-25T11:00:00.000Z', pending_at: '2026-11-25T11:01:00.000Z', settled_at: '2026-11-25T11:59:00.000Z' },
        earned: { impact_units: 1, credits: null },
        contributor: { account_id: '00000000-0000-7000-8000-00000000000c' },
        signer: { key_id: key.keyId, public_key: key.publicKey },
      },
      key,
    );
    const files: Record<string, string> = {
      'r.json': JSON.stringify({ receipt }),
      'bad.json': JSON.stringify({ ...receipt, earned: { impact_units: 2, credits: null } }),
      'keys.json': JSON.stringify({ keys: [{ key_id: key.keyId, public_key: key.publicKey, status: 'active' }] }),
      'other.json': JSON.stringify({ keys: [] }),
    };
    const d = { ...deps(200, {}), readFile: async (p: string) => files[p]! };
    const plain = capture();
    expect(await run(['receipt', 'verify', 'r.json'], plain.io, d)).toBe(0);
    expect(plain.out.join('\n')).toContain('1 impact');
    expect(plain.out.join('\n')).toContain('was not checked against');
    const pinned = capture();
    expect(await run(['receipt', 'verify', 'r.json', '--keys', 'keys.json'], pinned.io, d)).toBe(0);
    expect(pinned.out.at(-1)).toContain("one of the platform's receipt keys");
    const fetched = capture();
    expect(await run(['receipt', 'verify', 'r.json', '--fetch-keys'], fetched.io, { ...d, api: deps(200, JSON.parse(files['keys.json']!)).api })).toBe(0);
    const untrusted = capture();
    expect(await run(['receipt', 'verify', 'r.json', '--keys', 'other.json'], untrusted.io, d)).toBe(1);
    expect(untrusted.err[0]).toContain('untrusted_key');
    const edited = capture();
    expect(await run(['receipt', 'verify', 'bad.json'], edited.io, d)).toBe(1);
    expect(edited.err[0]).toContain('bad_signature');
    expect(await run(['receipt'], capture().io, d)).toBe(2);
  });
});
