import {
  apiErrorSchema,
  harnessReleaseSchema,
  modelSchema,
  swarmDetailSchema,
  swarmSummarySchema,
  type CatalogModel,
  type HarnessReleaseInfo,
  type SwarmDetail,
  type SwarmSummary,
} from '@swarm-explorer/api-client';
import type { getHarnessRelease, ModelRow, SwarmRow } from '@swarm-explorer/db';
import type { z } from 'zod';

/** Public reads are CDN cacheable with a short TTL. */
export const PUBLIC_CACHE = 'public, s-maxage=30, stale-while-revalidate=120';

export function toSwarmSummary(r: SwarmRow): SwarmSummary {
  const m = r.manifest;
  return {
    slug: r.swarm.slug,
    name: m.name,
    summary: m.summary,
    category: r.swarm.category,
    publisher: { slug: r.publisher.slug, name: r.publisher.name, badge: r.publisher.badgeStatus },
    featured: r.swarm.featuredStatus === 'featured',
    funding:
      m.credits.funded && m.credits.per_accepted_task
        ? { mode: 'funded', creditsPerAcceptedTask: m.credits.per_accepted_task, poolStatus: r.pool && r.pool.availableCached > 0 ? 'available' : 'empty' }
        : { mode: 'volunteer' },
    verification: m.verification,
    models: {
      policy: m.models.policy,
      classes: m.models.class ? [m.models.class] : (m.models.allowed_classes ?? []),
      apiAllowed: m.models.api_allowed,
    },
    harness: { name: m.harness.name, version: m.harness.version, runtime: m.harness.runtime },
    permissions: {
      network: m.permissions.network,
      scratchDiskGb: m.permissions.scratch_disk_gb,
      gpuCompute: m.permissions.gpu_compute,
      apiSpendDailyUsd: m.permissions.api_spend_daily_usd,
    },
  };
}

export function toSwarmDetail(r: SwarmRow): SwarmDetail {
  const m = r.manifest;
  return {
    ...toSwarmSummary(r),
    release: {
      id: r.release.id,
      manifestHash: r.release.manifestHash,
      permissionsHash: r.release.permissionsHash,
      publishedAt: r.release.publishedAt?.toISOString() ?? null,
      harnessHash: m.harness.hash,
      minClientVersion: m.min_client_version,
    },
    resultsUrl: m.results_url,
    qualification: m.qualification,
    task: { timeoutS: m.task.timeout_s, maxParallelPerNode: m.task.max_parallel_per_node, urgentAllowed: m.task.urgent_allowed },
    verificationConfig: {
      knownAnswerRate: m.verification_config.known_answer_rate ?? null,
      redundancyCount: m.verification_config.redundancy_count ?? null,
      juryPanelSize: m.verification_config.jury_panel_size ?? null,
      pendingWindowS: m.verification_config.pending_window_s,
    },
    dataPolicy: {
      publicInputs: m.data_policy.public_inputs,
      retentionDays: m.data_policy.retention_days,
      sensitiveDataProhibited: m.data_policy.sensitive_data_prohibited,
    },
    // No verified results exist yet, so no rate is shown (SPEC 4.2: never fake percentages).
    acceptance: { status: 'not_enough_history' },
    outcomes: [],
    trust: {
      releaseReviewed: r.release.reviewStatus === 'approved',
      harnessReviewed: r.harnessRelease.reviewStatus === 'approved',
      signatureKeyId: m.signatures?.[0]?.key_id ?? null,
      openReports: 0,
    },
    manifest: m as unknown as Record<string, unknown>,
  };
}

export function toModel(r: ModelRow): CatalogModel {
  return {
    slug: r.model.slug,
    displayName: r.model.displayName,
    source: r.model.source,
    family: r.model.family,
    modelClass: r.model.modelClass,
    licenseId: r.model.licenseId,
    artifacts: r.artifacts.map((a) => ({
      versionLabel: a.versionLabel,
      contentHash: a.contentHash,
      sizeBytes: a.sizeBytes,
      contextLength: a.contextLength,
      quantization: a.quantization,
      runtimeFormats: a.runtimeFormats,
      catalogVersion: a.catalogVersion,
      sourceRef: a.sourceRef,
    })),
    acceptedSwarms: r.acceptedSwarms,
  };
}

export function toHarnessRelease(r: NonNullable<Awaited<ReturnType<typeof getHarnessRelease>>>, downloadUrl: string | null = null): HarnessReleaseInfo {
  return {
    name: r.harness.name,
    version: r.release.version,
    publisher: { slug: r.publisher.slug, name: r.publisher.name, badge: r.publisher.badgeStatus },
    runtime: r.release.runtime,
    bundleHash: r.release.bundleHash,
    minModelClass: r.release.minModelClass,
    outputSchemaHash: r.release.outputSchemaHash,
    sbomHash: r.release.sbomHash,
    signature: r.release.signature,
    reviewed: r.release.reviewStatus === 'approved',
    revoked: r.release.revokedAt !== null,
    signingKey: r.signingKey,
    downloadUrl,
  };
}

/** Validates outgoing bodies too, so the contract cannot silently drift. */
export function json<S extends z.ZodType>(schema: S, body: z.input<S>, init: ResponseInit = {}): Response {
  return Response.json(schema.parse(body), init);
}

/** SPEC 13 error envelope: `{error:{code,message,details}}`. */
export function apiError(status: number, code: string, message: string, details?: unknown): Response {
  return json(apiErrorSchema, { error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Writes require an Idempotency-Key header (SPEC 13). OAuth protocol endpoints are the
 * exception: RFC 6749 clients do not send one, and code and refresh grants are single use.
 */
export function requireIdempotencyKey(req: Request): { key: string } | Response {
  const key = req.headers.get('idempotency-key');
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    return apiError(400, 'idempotency_key_required', 'Writes need an Idempotency-Key header of 16 to 128 URL-safe characters.');
  }
  return { key };
}

export { harnessReleaseSchema, modelSchema, swarmDetailSchema, swarmSummarySchema };
