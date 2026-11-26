import type { RevocationEntry } from '@swarm-explorer/api-client';
import type { revocations } from '@swarm-explorer/db';

/** A revocation row in its wire form (SPEC 13.1 feed, 13.4 admin). */
export function toRevocationEntry(r: typeof revocations.$inferSelect): RevocationEntry {
  return {
    id: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    severity: r.severity,
    signedPayload: r.signedPayload,
    effectiveAt: r.effectiveAt.toISOString(),
    action: r.action,
    signature: r.signature,
  };
}
