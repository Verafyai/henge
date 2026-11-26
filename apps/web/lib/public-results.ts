import type { PublicResult } from '@swarm-explorer/api-client';
import type { PublicResultView } from '@swarm-explorer/db';

/** A settled result in its public wire form (SPEC 13.3 `GET /results/{id}`): hashes and pins only. */
export function toPublicResult(v: PublicResultView): PublicResult {
  return {
    result_id: v.resultId,
    swarm: v.swarm,
    output_sha256: v.outputSha256,
    harness: v.harness,
    model_artifact_hash: v.modelArtifactHash,
    verification: v.verification.map((x) => ({ method: x.method, outcome: x.outcome, verifier_version: x.verifierVersion })),
    impact_units: v.impactUnits,
    settled_at: v.settledAt,
  };
}
