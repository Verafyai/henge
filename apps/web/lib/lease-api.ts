/**
 * Shared pieces of the task protocol endpoints (SPEC 13.3): the lease view, the ownership guard and
 * server-side checks on a submitted result. A lease is reachable only from the install of its node.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runRecordMessage, type Lease, type LeaseUnavailable, type RunRecord } from '@swarm-explorer/api-client';
import { getDb, harnessForRelease, leases, type LeaseGrant } from '@swarm-explorer/db';
import { canonicalJson } from '@swarm-explorer/schema';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apiError } from './api';
import type { Authed } from './auth/oauth';
import { localBundleDir } from './bundles';
import { ownedNode } from './node-auth';

export const unavailableMessage: Record<LeaseUnavailable, string> = {
  no_tasks: 'This swarm has no tasks waiting. Your share is lent to your other swarms meanwhile.',
  pool_empty: "The publisher's prepaid pool has no credits available for paid tasks.",
  paid_leasing_unavailable: 'Paid tasks start once publisher funding is live.',
};

export function toLeaseView(g: LeaseGrant, origin: string): Lease {
  return {
    lease_id: g.lease.id,
    task_id: g.taskId,
    swarm: g.swarm,
    swarm_release_id: g.releaseId,
    status: g.lease.status,
    urgent: g.lease.urgent,
    deadline_at: g.lease.deadlineAt.toISOString(),
    harness: g.harness,
    model_requirement: g.modelRequirement,
    input: { uri: new URL(`/v1/leases/${g.lease.id}/input`, origin).toString(), sha256: g.inputHash },
    output_schema_hash: g.outputSchemaHash,
    reward: g.reward,
    permissions_hash: g.permissionsHash,
  };
}

/** Loads a lease the caller's install may act on. Anything else is a 404. */
export async function guardLease(auth: Pick<Authed, 'user' | 'install'>, rawId: string) {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return apiError(400, 'invalid_id', 'That lease id is not valid.');
  const db = await getDb();
  const [l] = await db.select().from(leases).where(eq(leases.id, id.data)).limit(1);
  if (!l || l.accountId !== auth.user.id || !(await ownedNode(auth.user, auth.install.id, l.nodeId))) return apiError(404, 'not_found', 'No such lease.');
  return l;
}

export const digestOf = (v: unknown) => `sha256-${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;

/** The run record must be signed by the device key of the install that holds the lease (SPEC 13.3). */
export function runRecordSignatureValid(record: RunRecord, devicePublicKey: string): boolean {
  const { signature, ...rest } = record;
  try {
    const key = createPublicKey({ key: Buffer.from(devicePublicKey, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(runRecordMessage(canonicalJson(rest))), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * Checks the output against the harness output schema when the coordinator hosts the bundle, and only
 * when that schema file still matches its pinned hash. Null means it could not be checked here; the
 * verifier (M6) checks again either way.
 */
export async function outputSchemaValid(releaseId: string, output: unknown): Promise<boolean | null> {
  const h = await harnessForRelease(releaseId);
  if (!h) return null;
  try {
    const dir = localBundleDir(h.name);
    const meta = JSON.parse(readFileSync(path.join(dir, 'harness.json'), 'utf8')) as { output_schema: string };
    const raw = readFileSync(path.join(dir, meta.output_schema));
    if (`sha256-${createHash('sha256').update(raw).digest('hex')}` !== h.hr.outputSchemaHash) return null;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    return Boolean(ajv.compile(JSON.parse(raw.toString('utf8')) as object)(output));
  } catch {
    return null;
  }
}
