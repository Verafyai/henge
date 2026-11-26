/**
 * Verifier worker guard (SPEC 13.3 `POST /verifications`). The worker is not a user: it signs each
 * request with its Ed25519 key over method, path, body hash, timestamp and nonce, like a device. Keys
 * are registered from `VERIFIER_WORKER_KEYS`; each nonce is accepted once per key.
 */
import { registerWorkerKeysFromEnv, useVerifierNonce, verifierKey, type PipelineDeps } from '@swarm-explorer/db';
import { bodySha256, VERIFIER_HEADERS, VERIFIER_NONCE, verifierRequestMessage, verifySignature } from '@swarm-explorer/verify';
import { apiError } from './api';
import { NO_STORE } from './api-auth';
import { DEVICE_PROOF_SKEW_MS } from './auth/oauth';
import { outputSchemaValid } from './lease-api';

const MAX_BODY = 256 * 1024;
const g = globalThis as unknown as { __verifierKeysRegistered?: Promise<number> };

export type VerifierCtx = { keyId: string; body: string };

/** What the API's lazy verification pass uses here: the hosted bundle's output schema. No real juries yet. */
export const pipelineDeps = (): PipelineDeps => ({ schemaCheck: outputSchemaValid });

export function withVerifierAuth<C>(handler: (req: Request, v: VerifierCtx, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    const finish = (res: Response) => {
      for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
      return res;
    };
    g.__verifierKeysRegistered ??= registerWorkerKeysFromEnv();
    await g.__verifierKeysRegistered;
    const keyId = req.headers.get(VERIFIER_HEADERS.keyId) ?? '';
    const ts = Number(req.headers.get(VERIFIER_HEADERS.ts));
    const nonce = req.headers.get(VERIFIER_HEADERS.nonce) ?? '';
    const sig = req.headers.get(VERIFIER_HEADERS.signature) ?? '';
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId) || !Number.isSafeInteger(ts) || !VERIFIER_NONCE.test(nonce) || !/^[A-Za-z0-9_-]{80,90}$/.test(sig))
      return finish(apiError(401, 'verifier_signature_required', 'Verifier requests must be signed with a registered verifier key.'));
    if (Math.abs(Date.now() - ts) > DEVICE_PROOF_SKEW_MS) return finish(apiError(401, 'verifier_clock_skew', 'The verifier clock is too far off.'));
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return finish(apiError(413, 'body_too_large', 'Request body is too large.'));
    const body = await req.text();
    if (Buffer.byteLength(body) > MAX_BODY) return finish(apiError(413, 'body_too_large', 'Request body is too large.'));
    const key = await verifierKey(keyId);
    if (!key || key.status !== 'active' || key.kind !== 'worker') return finish(apiError(401, 'unknown_verifier', 'That verifier key is not registered.'));
    const u = new URL(req.url);
    const message = verifierRequestMessage({ method: req.method, path: `${u.pathname}${u.search}`, bodySha256: bodySha256(body), ts, nonce });
    if (!verifySignature(key.publicKey, message, sig)) return finish(apiError(401, 'verifier_signature_invalid', 'The verifier signature did not verify.'));
    if (!(await useVerifierNonce(keyId, nonce))) return finish(apiError(401, 'verifier_nonce_reused', 'That request was already used.'));
    return finish(await handler(req, { keyId, body }, ctx));
  };
}
