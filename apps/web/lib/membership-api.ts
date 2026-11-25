/**
 * Shared pieces of the join and qualification endpoints (SPEC 13.2): the membership view, error
 * mapping, and the ownership guard. A membership is reachable only from the install of its node.
 */
import type { MembershipView } from '@swarm-explorer/api-client';
import { getDb, memberships, MembershipError, nodeMemberships, type QualificationProgress } from '@swarm-explorer/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apiError } from './api';
import type { Authed } from './auth/oauth';
import { ownedNode } from './node-auth';

type Row = Awaited<ReturnType<typeof nodeMemberships>>[number];

export function toQualification(q: QualificationProgress): MembershipView['qualification'] {
  return { id: q.id, tasks: q.tasks, pass: q.pass, attempts: q.attempts, passed: q.passed, outcome: q.outcome, retry_reason: q.retryReason };
}

export function toMembershipView(r: Row, queue?: Map<string, { queued: number; urgent: number }>): MembershipView {
  return {
    id: r.membership.id,
    swarm: r.swarm.slug,
    node_id: r.membership.nodeId,
    status: r.membership.status,
    share_bp: r.membership.shareBp,
    release_id: r.release.id,
    manifest_hash: r.release.manifestHash,
    permissions_hash: r.release.permissionsHash,
    harness: { name: r.manifest.harness.name, version: r.manifest.harness.version, hash: r.manifest.harness.hash },
    joined_at: r.membership.joinedAt.toISOString(),
    qualification: r.qualification ? toQualification(r.qualification) : null,
    queue: queue ? (queue.get(r.swarm.id) ?? { queued: 0, urgent: 0 }) : null,
  };
}

/** The current view of one membership, after a change. */
export async function membershipView(accountId: string, nodeId: string, membershipId: string): Promise<MembershipView | null> {
  const row = (await nodeMemberships(accountId, nodeId)).find((r) => r.membership.id === membershipId);
  return row ? toMembershipView(row) : null;
}

export function membershipErrorResponse(e: unknown): Response {
  if (e instanceof MembershipError) return apiError(e.status, e.code, e.message, e.details);
  throw e;
}

/** Loads a membership the caller's install may act on. Anything else is a 404. */
export async function guardMembership(auth: Pick<Authed, 'user' | 'install'>, rawId: string) {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return apiError(400, 'invalid_id', 'That membership id is not valid.');
  const db = await getDb();
  const [m] = await db.select().from(memberships).where(eq(memberships.id, id.data)).limit(1);
  if (!m || m.accountId !== auth.user.id || !(await ownedNode(auth.user, auth.install.id, m.nodeId))) return apiError(404, 'not_found', 'No such membership.');
  return m;
}
