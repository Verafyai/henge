import type { ManifestV1 } from '@swarm-explorer/schema';
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from './client';
import { fitCalibrations, harnesses, harnessReleases, licenseAcceptances, modelArtifacts, models, nodeCapabilities, nodeModels, pools, publisherKeys, publishers, revocations, swarmReleases, swarms } from './schema';

/** Public catalog reads (SPEC 13.1). Only listed, public swarms with an approved, unrevoked release. */
export type SwarmRow = {
  swarm: typeof swarms.$inferSelect;
  publisher: Pick<typeof publishers.$inferSelect, 'slug' | 'name' | 'badgeStatus'>;
  release: typeof swarmReleases.$inferSelect;
  harnessRelease: typeof harnessReleases.$inferSelect;
  pool: Pick<typeof pools.$inferSelect, 'slug' | 'availableCached' | 'reservedCached'> | null;
  manifest: ManifestV1;
};

async function currentReleases(where?: ReturnType<typeof eq>) {
  const db = await getDb();
  const rows = await db
    .select({
      swarm: swarms,
      publisher: { slug: publishers.slug, name: publishers.name, badgeStatus: publishers.badgeStatus },
      release: swarmReleases,
      harnessRelease: harnessReleases,
      pool: { slug: pools.slug, availableCached: pools.availableCached, reservedCached: pools.reservedCached },
    })
    .from(swarms)
    .innerJoin(publishers, eq(publishers.id, swarms.publisherId))
    .innerJoin(swarmReleases, and(eq(swarmReleases.swarmId, swarms.id), eq(swarmReleases.reviewStatus, 'approved'), isNull(swarmReleases.revokedAt)))
    .innerJoin(harnessReleases, eq(harnessReleases.id, swarmReleases.harnessReleaseId))
    .leftJoin(pools, eq(pools.swarmId, swarms.id))
    .where(and(eq(swarms.visibility, 'public'), eq(swarms.status, 'listed'), eq(publishers.status, 'active'), where))
    .orderBy(asc(swarms.slug), desc(swarmReleases.publishedAt));
  // Newest approved release per swarm.
  const seen = new Set<string>();
  const out: SwarmRow[] = [];
  for (const r of rows) {
    if (seen.has(r.swarm.id)) continue;
    seen.add(r.swarm.id);
    out.push({ ...r, pool: r.pool?.slug ? r.pool : null, manifest: r.release.manifestJson as ManifestV1 });
  }
  return out;
}

export async function listSwarms(opts: { category?: string } = {}): Promise<SwarmRow[]> {
  const rows = await currentReleases();
  return opts.category ? rows.filter((r) => r.swarm.category === opts.category) : rows;
}

export async function getSwarm(slug: string): Promise<SwarmRow | null> {
  return (await currentReleases(eq(swarms.slug, slug)))[0] ?? null;
}

export type ModelRow = {
  model: typeof models.$inferSelect;
  artifacts: Array<typeof modelArtifacts.$inferSelect>;
  acceptedSwarms: string[];
};

/** Which listed swarms accept a model class under their model policy (SPEC 6.2). */
export function policyAccepts(m: ManifestV1, modelClass: string): boolean {
  switch (m.models.policy) {
    case 'any':
      return true;
    case 'class':
      return m.models.class === modelClass || Boolean(m.models.allowed_classes?.includes(modelClass));
    case 'diverse':
      return m.models.allowed_classes ? m.models.allowed_classes.includes(modelClass) : true;
  }
}

export async function listModels(): Promise<ModelRow[]> {
  const db = await getDb();
  const [ms, arts, listed] = await Promise.all([
    db.select().from(models).where(eq(models.reviewStatus, 'approved')).orderBy(asc(models.displayName)),
    db.select().from(modelArtifacts).orderBy(asc(modelArtifacts.versionLabel)),
    currentReleases(),
  ]);
  return ms.map((model) => ({
    model,
    artifacts: arts.filter((a) => a.modelId === model.id),
    acceptedSwarms: listed.filter((s) => policyAccepts(s.manifest, model.modelClass)).map((s) => s.swarm.slug),
  }));
}

export async function getModel(slug: string): Promise<ModelRow | null> {
  return (await listModels()).find((m) => m.model.slug === slug) ?? null;
}

export async function getHarnessRelease(name: string, version: string) {
  const db = await getDb();
  const [row] = await db
    .select({ harness: harnesses, release: harnessReleases, publisher: { slug: publishers.slug, name: publishers.name, badgeStatus: publishers.badgeStatus } })
    .from(harnessReleases)
    .innerJoin(harnesses, eq(harnesses.id, harnessReleases.harnessId))
    .innerJoin(publishers, eq(publishers.id, harnesses.publisherId))
    .where(and(eq(harnesses.name, name), eq(harnessReleases.version, version), eq(harnessReleases.reviewStatus, 'approved')));
  if (!row) return null;
  const keyId = row.release.signature.split(':')[0] ?? '';
  const [key] = await db
    .select({ keyId: publisherKeys.keyId, publicKey: publisherKeys.publicKey, status: publisherKeys.status })
    .from(publisherKeys)
    .innerJoin(publishers, eq(publishers.id, publisherKeys.publisherId))
    .where(and(eq(publisherKeys.keyId, keyId), eq(publishers.slug, row.publisher.slug)));
  return { ...row, signingKey: key ?? null };
}

export async function listRevocations(since: Date | null) {
  const db = await getDb();
  return db
    .select()
    .from(revocations)
    .where(since ? gt(revocations.effectiveAt, since) : undefined)
    .orderBy(asc(revocations.effectiveAt))
    .limit(500);
}

/** Active keys for a publisher, for signature checks (SPEC 11.6). */
export async function publisherKeyLookup() {
  const db = await getDb();
  const rows = await db
    .select({ keyId: publisherKeys.keyId, publicKey: publisherKeys.publicKey, status: publisherKeys.status, publisher: publishers.slug })
    .from(publisherKeys)
    .innerJoin(publishers, eq(publishers.id, publisherKeys.publisherId));
  const map = new Map(rows.map((r) => [r.keyId, r]));
  return (keyId: string) => map.get(keyId);
}

/** Model artifact by its pinned content hash, with its model, when the model is approved. */
export async function getArtifactByHash(contentHash: string) {
  const db = await getDb();
  const [row] = await db
    .select({ artifact: modelArtifacts, model: models })
    .from(modelArtifacts)
    .innerJoin(models, eq(models.id, modelArtifacts.modelId))
    .where(and(eq(modelArtifacts.contentHash, contentHash), eq(models.reviewStatus, 'approved')));
  return row ?? null;
}

/** The approved speed thresholds for a runtime at a catalog version, if any (SPEC 5.4). */
export async function approvedCalibration(runtime: string, catalogVersion: number) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(fitCalibrations)
    .where(and(eq(fitCalibrations.runtime, runtime), eq(fitCalibrations.catalogVersion, catalogVersion), eq(fitCalibrations.status, 'approved')));
  return row ?? null;
}

export async function latestCapabilities(nodeId: string) {
  const db = await getDb();
  const [row] = await db.select().from(nodeCapabilities).where(eq(nodeCapabilities.nodeId, nodeId)).orderBy(desc(nodeCapabilities.observedAt)).limit(1);
  return row ?? null;
}

/** Records a verified install and its benchmark. Last write wins per node and artifact. */
export async function recordNodeModel(v: { nodeId: string; modelArtifactId: string; verifiedHash: string; benchmarkTps: number | null; fitStatus: (typeof nodeModels.$inferInsert)['fitStatus'] }) {
  const db = await getDb();
  const [row] = await db
    .insert(nodeModels)
    .values(v)
    .onConflictDoUpdate({ target: [nodeModels.nodeId, nodeModels.modelArtifactId], set: { verifiedHash: v.verifiedHash, benchmarkTps: v.benchmarkTps, fitStatus: v.fitStatus } })
    .returning();
  return row!;
}

export async function recordLicenseAcceptance(accountId: string, modelArtifactId: string, licenseId: string) {
  const db = await getDb();
  await db.insert(licenseAcceptances).values({ accountId, modelArtifactId, licenseId }).onConflictDoNothing();
  const [row] = await db.select().from(licenseAcceptances).where(and(eq(licenseAcceptances.accountId, accountId), eq(licenseAcceptances.modelArtifactId, modelArtifactId)));
  return row!;
}
