import { resultSubmitSchema, resultSubmittedSchema } from '@swarm-explorer/api-client';
import { getDb, intakeResult, leases, runCoordinatorMethods, submitResult, tasks } from '@swarm-explorer/db';
import { eq } from 'drizzle-orm';
import { apiError, json } from '@/lib/api';
import { digestOf, guardLease, outputSchemaValid, runRecordSignatureValid } from '@/lib/lease-api';
import { membershipErrorResponse } from '@/lib/membership-api';
import { parseJsonBody, withNodeAuth } from '@/lib/node-auth';
import { pipelineDeps } from '@/lib/verifier-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/leases/{id}/results (SPEC 13.3): output plus a device-signed run record. Idempotent by
 * lease and result hash. Late and after-abandon results are recorded and never paid. On-time results
 * go through intake (schema and signature) to Verifying, then the coordinator-side methods run; a
 * machine check waits for the verifier worker. Nothing is credited here.
 */
export const POST = withNodeAuth<{ params: Promise<{ id: string }> }>(async (_req, auth, { params }) => {
  const l = await guardLease(auth, (await params).id);
  if (l instanceof Response) return l;
  const parsed = resultSubmitSchema.safeParse(parseJsonBody(auth.body));
  if (!parsed.success) return apiError(400, 'invalid_body', 'The result does not match the schema.', { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const { output, output_sha256, run_record: rec } = parsed.data;
  if (digestOf(output) !== output_sha256 || rec.output_sha256 !== output_sha256) return apiError(400, 'output_hash_mismatch', 'output_sha256 does not match the output or the run record.');
  if (rec.lease_id !== l.id || rec.node_id !== l.nodeId) return apiError(400, 'run_record_mismatch', 'The run record names a different lease or node.');
  if (!runRecordSignatureValid(rec, auth.install.devicePublicKey)) return apiError(401, 'run_record_signature_invalid', 'The run record is not signed by this device.');
  const db = await getDb();
  const [task] = await db.select({ releaseId: tasks.releaseId }).from(tasks).where(eq(tasks.id, l.taskId));
  try {
    const r = await submitResult({
      accountId: auth.user.id,
      leaseId: l.id,
      output,
      outputHash: output_sha256,
      schemaValid: await outputSchemaValid(task!.releaseId, output),
      run: {
        modelIdClaim: rec.model.claimed_id,
        modelArtifactHash: rec.model.artifact_hash,
        provider: rec.model.source === 'provider' ? 'provider' : null,
        harnessHash: rec.harness_hash,
        tokensIn: rec.tokens.input,
        tokensOut: rec.tokens.output,
        elapsedMs: rec.elapsed_ms,
        costUsdMicrosReported: rec.api_cost.reported_usd_micros,
        signature: rec.signature,
        record: rec,
      },
    });
    let status = r.lease.status;
    if (r.result.disposition === 'on_time') {
      const deps = pipelineDeps();
      await intakeResult(r.result.id, deps);
      await runCoordinatorMethods(r.result.id, deps);
      const [now] = await db.select({ status: leases.status }).from(leases).where(eq(leases.id, l.id));
      status = now!.status;
    }
    return json(
      resultSubmittedSchema,
      { lease_id: l.id, result_id: r.result.id, status, disposition: r.result.disposition, duplicate: r.duplicate, awaiting_verification: r.result.disposition === 'on_time' },
      { status: r.duplicate ? 200 : 201 },
    );
  } catch (e) {
    return membershipErrorResponse(e);
  }
});
