/**
 * Node endpoint guard (SPEC 13): bearer token, then a device signature over method, path, body
 * hash, timestamp and nonce, verified against the install's registered device key. Nonces are
 * single use per install. Writes are idempotent by Idempotency-Key.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { DEVICE_HEADERS, DEVICE_NONCE, deviceRequestMessage } from '@swarm-explorer/api-client';
import { can } from '@swarm-explorer/core';
import { deviceNonces, getDb, idempotencyRecords, nodes } from '@swarm-explorer/db';
import { and, eq, lt } from 'drizzle-orm';
import { apiError, requireIdempotencyKey } from './api';
import { NO_STORE } from './api-auth';
import { authenticate, DEVICE_PROOF_SKEW_MS, type Authed } from './auth/oauth';

export const MAX_NODE_BODY_BYTES = 64 * 1024;

export type NodeCtx = Authed & { body: string };

const b64u = (b: Buffer) => b.toString('base64url');

export async function verifyDeviceRequest(req: Request, auth: Authed, body: string, now = Date.now()): Promise<Response | null> {
  const ts = Number(req.headers.get(DEVICE_HEADERS.ts));
  const nonce = req.headers.get(DEVICE_HEADERS.nonce) ?? '';
  const sig = req.headers.get(DEVICE_HEADERS.signature) ?? '';
  if (!Number.isSafeInteger(ts) || !DEVICE_NONCE.test(nonce) || !/^[A-Za-z0-9_-]{80,90}$/.test(sig)) {
    return apiError(401, 'device_signature_required', 'Node requests must be signed with the device key.');
  }
  if (Math.abs(now - ts) > DEVICE_PROOF_SKEW_MS) return apiError(401, 'device_clock_skew', 'The device clock is too far off. Check the time on this computer.');
  const u = new URL(req.url);
  const message = deviceRequestMessage({ method: req.method, path: `${u.pathname}${u.search}`, bodySha256: b64u(createHash('sha256').update(body).digest()), ts, nonce });
  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.from(auth.install.devicePublicKey, 'base64url'), format: 'der', type: 'spki' });
    ok = verify(null, Buffer.from(message), key, Buffer.from(sig, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return apiError(401, 'device_signature_invalid', 'The device signature did not verify.');

  const db = await getDb();
  // Prune old nonces for this install opportunistically; the skew window bounds replay anyway.
  await db.delete(deviceNonces).where(and(eq(deviceNonces.installId, auth.install.id), lt(deviceNonces.seenAt, new Date(now - 2 * DEVICE_PROOF_SKEW_MS))));
  const inserted = await db.insert(deviceNonces).values({ installId: auth.install.id, nonce }).onConflictDoNothing().returning({ nonce: deviceNonces.nonce });
  if (inserted.length === 0) return apiError(401, 'device_nonce_reused', 'That request was already used.');
  return null;
}

type Handler<C> = (req: Request, ctx: NodeCtx, routeCtx: C) => Promise<Response>;

/** Wraps a node write: bearer, size limit, device signature, nonce, idempotency replay. */
export function withNodeAuth<C>(handler: Handler<C>, opts: { write: boolean } = { write: true }) {
  return async (req: Request, routeCtx: C) => {
    const finish = (res: Response) => {
      for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
      return res;
    };
    const auth = await authenticate(req);
    if (!auth) {
      const res = apiError(401, 'unauthorized', 'Sign in again.');
      res.headers.set('www-authenticate', 'Bearer');
      return finish(res);
    }
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_NODE_BODY_BYTES) return finish(apiError(413, 'body_too_large', 'Request body is too large.'));
    const body = await req.text();
    if (Buffer.byteLength(body) > MAX_NODE_BODY_BYTES) return finish(apiError(413, 'body_too_large', 'Request body is too large.'));

    let idemKey: string | null = null;
    if (opts.write) {
      const idem = requireIdempotencyKey(req);
      if (idem instanceof Response) return finish(idem);
      idemKey = idem.key;
    }
    const bad = await verifyDeviceRequest(req, auth, body);
    if (bad) return finish(bad);

    const path = new URL(req.url).pathname;
    const requestHash = createHash('sha256').update(`${req.method}\n${path}\n${body}`).digest('hex');
    const db = await getDb();
    if (idemKey) {
      const [prev] = await db
        .select()
        .from(idempotencyRecords)
        .where(and(eq(idempotencyRecords.accountId, auth.user.id), eq(idempotencyRecords.key, idemKey)))
        .limit(1);
      if (prev) {
        if (prev.requestHash !== requestHash) return finish(apiError(422, 'idempotency_key_reused', 'That Idempotency-Key was used for a different request.'));
        return finish(Response.json(prev.responseBody, { status: prev.responseStatus, headers: { 'idempotent-replay': 'true' } }));
      }
    }
    const res = await handler(req, { ...auth, body }, routeCtx);
    if (idemKey && res.status < 500 && res.headers.get('content-type')?.includes('application/json')) {
      const responseBody = (await res.clone().json()) as unknown;
      await db
        .insert(idempotencyRecords)
        .values({ key: idemKey, accountId: auth.user.id, method: req.method, path, requestHash, responseStatus: res.status, responseBody: responseBody as object })
        .onConflictDoNothing();
    }
    return finish(res);
  };
}

/** The caller's own node, or null. "Not yours" and "missing" look the same to the caller. */
export async function ownedNode(user: Authed['user'], installId: string, nodeId: string) {
  const db = await getDb();
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node || !can(user, 'node.report', { accountId: node.accountId, installId: node.installId, callerInstallId: installId })) return null;
  return node;
}

export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
