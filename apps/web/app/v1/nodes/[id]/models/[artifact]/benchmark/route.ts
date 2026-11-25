import { benchmarkAcceptedSchema, benchmarkSubmitSchema, digestSchema } from '@swarm-explorer/api-client';
import { approvedCalibration, getArtifactByHash, recordNodeModel } from '@swarm-explorer/db';
import { fitFromBenchmark } from '@swarm-explorer/node-core';
import { z } from 'zod';
import { apiError, json } from '@/lib/api';
import { ownedNode, parseJsonBody, withNodeAuth } from '@/lib/node-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/nodes/{node_id}/models/{artifact}/benchmark (SPEC 13.1). Records a verified install and
 * its measured tokens per second. The node must report the pinned hash; anything else is refused,
 * so a drifted artifact never counts as installed. Fit becomes benchmark-backed only against an
 * approved calibration for the runtime and catalog version (SPEC 5.4).
 */
export const POST = withNodeAuth<{ params: Promise<{ id: string; artifact: string }> }>(async (_req, { user, install, body }, { params }) => {
  const p = await params;
  const nodeId = z.uuid().safeParse(p.id);
  const hash = digestSchema.safeParse(decodeURIComponent(p.artifact));
  if (!nodeId.success || !hash.success) return apiError(400, 'invalid_id', 'That node or artifact id is not valid.');
  const parsed = benchmarkSubmitSchema.safeParse(parseJsonBody(body));
  if (!parsed.success) return apiError(400, 'invalid_body', 'The benchmark does not match the schema.', { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const node = await ownedNode(user, install.id, nodeId.data);
  if (!node) return apiError(404, 'not_found', 'No such node.');
  const row = await getArtifactByHash(hash.data);
  if (!row) return apiError(404, 'not_found', 'No such model artifact.');
  const b = parsed.data;
  if (b.verified_hash !== row.artifact.contentHash) return apiError(409, 'hash_mismatch', 'The verified hash does not match the pinned artifact.');
  if (!row.artifact.runtimeFormats.includes(b.runtime === 'ollama' ? 'ollama' : 'gguf')) return apiError(400, 'runtime_mismatch', 'That artifact does not run on this runtime.');

  const cal = b.tokens_per_second === null ? null : await approvedCalibration(b.runtime, row.artifact.catalogVersion);
  const estimate = { status: b.estimated_fit, basis: 'estimate' as const, reason: 'gpu_memory' as const };
  const fit = b.tokens_per_second === null ? estimate : fitFromBenchmark(b.tokens_per_second, estimate, cal ? { runtime: b.runtime, catalogVersion: cal.catalogVersion, runsWellMinTps: cal.runsWellMinTps, runsSlowlyMinTps: cal.runsSlowlyMinTps } : null);
  const saved = await recordNodeModel({ nodeId: node.id, modelArtifactId: row.artifact.id, verifiedHash: b.verified_hash, benchmarkTps: b.tokens_per_second, fitStatus: fit.status });
  return json(benchmarkAcceptedSchema, { content_hash: row.artifact.contentHash, benchmark_tps: saved.benchmarkTps, fit_status: saved.fitStatus, basis: fit.basis, calibration_version: cal?.catalogVersion ?? null });
});
