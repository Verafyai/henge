import { verifyManifestSignatures } from '@swarm-explorer/schema/node';
import { validateManifest } from '@swarm-explorer/schema';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from './client';
import { getSwarm, listModels, listSwarms, publisherKeyLookup } from './queries';
import { creditAccounts, economicConfigs, ledgerEntries, pools, swarmReleases } from './schema';
import { manifestHash, permissionsHash } from './seed';
import { runMigrations, seed } from './testing';
import { uuidv7 } from './uuid';

beforeAll(async () => {
  await runMigrations();
  await seed();
}, 60_000);

describe('seeded catalog', () => {
  it('lists the three launch swarms with valid, signed manifests', async () => {
    const rows = await listSwarms();
    expect(rows.map((r) => r.swarm.slug).sort()).toEqual(['challenge-vaults', 'prompt-guard-red-team', 'verafy-dao-juries']);
    const lookup = await publisherKeyLookup();
    for (const r of rows) {
      expect(validateManifest(r.manifest).ok).toBe(true);
      expect(verifyManifestSignatures(r.manifest, (id) => {
        const k = lookup(id);
        return k && { keyId: k.keyId, publisher: k.publisher, publicKey: k.publicKey, status: k.status };
      })).toMatchObject({ ok: true });
      expect(r.release.manifestHash).toBe(manifestHash(r.manifest));
      expect(r.release.permissionsHash).toBe(permissionsHash(r.manifest));
      expect(r.harnessRelease.bundleHash).toBe(r.manifest.harness.hash);
    }
  });

  it('funds only the funded swarm, and its pool starts empty (no approved pricing)', async () => {
    const juries = await getSwarm('verafy-dao-juries');
    expect(juries?.swarm.fundedMode).toBe('funded');
    expect(juries?.pool).toEqual({ slug: 'pool-verafy-dao-juries', availableCached: 0, reservedCached: 0 });
    for (const slug of ['challenge-vaults', 'prompt-guard-red-team']) {
      const s = await getSwarm(slug);
      expect(s?.swarm.fundedMode).toBe('volunteer');
      expect(s?.pool).toBeNull();
    }
  });

  it('filters by category and hides unknown slugs', async () => {
    expect((await listSwarms({ category: 'mathematics' })).map((r) => r.swarm.slug)).toEqual(['challenge-vaults']);
    expect(await getSwarm('nope')).toBeNull();
  });

  it('a revoked release drops out of the public catalog', async () => {
    const db = await getDb();
    const s = await getSwarm('prompt-guard-red-team');
    await db.update(swarmReleases).set({ revokedAt: new Date() }).where(eq(swarmReleases.id, s!.release.id));
    expect(await getSwarm('prompt-guard-red-team')).toBeNull();
    await db.update(swarmReleases).set({ revokedAt: null }).where(eq(swarmReleases.id, s!.release.id));
  });

  it('seeds exactly the five approved pins (docs/catalog/proposal-2026-11-25.json) and no test-only model', async () => {
    const ms = await listModels();
    const byRef = (a: { ref: string }, b: { ref: string }) => (a.ref < b.ref ? -1 : 1);
    const pins = ms.map((m) => ({ ref: m.artifacts[0]!.sourceRef, hash: m.artifacts[0]!.contentHash, size: m.artifacts[0]!.sizeBytes, license: m.model.licenseId })).sort(byRef);
    expect(pins).toEqual([
      { ref: 'phi4-mini:3.8b-q4_K_M', hash: 'sha256-78fad5d182a7c33065e153a5f8ba210754207ba9d91973f57dffa7f487363753', size: 2_491_876_774, license: 'mit' },
      { ref: 'qwen2.5:7b-instruct-q4_K_M', hash: 'sha256-845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e', size: 4_683_087_332, license: 'apache-2.0' },
      { ref: 'mistral-nemo:12b-instruct-2407-q4_K_M', hash: 'sha256-daf6737417121831e572a9c482e92a221ee0c33537f35f1f857c7b4f7191df55', size: 7_477_217_229, license: 'apache-2.0' },
      { ref: 'phi4:14b-q4_K_M', hash: 'sha256-ac896e5b8b34a1f4efa7b14d7520725140d5512484457fab45d2a4ea14c69dba', size: 9_053_116_391, license: 'mit' },
      { ref: 'mistral-small:24b-instruct-2501-q4_K_M', hash: 'sha256-8039dd90c1138d772437a0779a33b7349efd5d9cca71edcd26e4dd463f90439d', size: 14_333_921_662, license: 'apache-2.0' },
    ].sort(byRef));
    for (const p of pins) expect(p.ref, p.ref).toMatch(/:[^:]*-q\d_[A-Z0-9_]+$/i); // An exact quantization tag, never a moving one.
    expect(ms.some((m) => m.model.slug.startsWith('test-only') || m.model.family === 'granite')).toBe(false);
    // Every launch manifest's model policy accepts at least one seeded model.
    for (const s of await listSwarms()) expect(ms.some((m) => m.acceptedSwarms.includes(s.swarm.slug)), s.swarm.slug).toBe(true);
  });

  it('maps model classes to the swarms that accept them', async () => {
    const ms = await listModels();
    const by = Object.fromEntries(ms.map((m) => [m.model.slug, m.acceptedSwarms.sort()]));
    expect(by['phi4-14b']).toEqual(['challenge-vaults', 'prompt-guard-red-team']);
    expect(by['qwen2.5-7b']).toEqual(['prompt-guard-red-team', 'verafy-dao-juries']);
    // Three distinct families can serve the diverse jury panel (min_families 3).
    expect(new Set(ms.filter((m) => m.acceptedSwarms.includes('verafy-dao-juries')).map((m) => m.model.family)).size).toBeGreaterThanOrEqual(3);
  });

  it('stores the approved v1 economic config: 1 credit = $0.01, 20 percent take rate', async () => {
    const db = await getDb();
    const rows = await db.select().from(economicConfigs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'approved', creditPriceMinor: 1, currency: 'USD', takeRateBp: 2000, hostedFreeTaskVolume: null, privateSeatPriceMinor: null });
    expect(rows[0]!.effectiveAt?.toISOString()).toBe('2026-11-25T00:00:00.000Z');
  });
});

describe('ledger invariants enforced by the database (SPEC 9.5)', () => {
  async function account() {
    const db = await getDb();
    const [a] = await db.insert(creditAccounts).values({ ownerType: 'account', ownerId: uuidv7() }).returning();
    return a!.id;
  }
  const entry = (creditAccountId: string, debit: number, credit: number) => ({
    txnId: uuidv7(),
    creditAccountId,
    debitCredits: debit,
    creditCredits: credit,
    movementType: 'correction' as const,
    referenceType: 'test',
    referenceId: 'test',
    idempotencyKey: uuidv7(),
    correlationId: uuidv7(),
  });

  it('refuses UPDATE and DELETE on ledger rows', async () => {
    const db = await getDb();
    const [row] = await db.insert(ledgerEntries).values(entry(await account(), 5, 0)).returning();
    await expect(db.update(ledgerEntries).set({ debitCredits: 6 }).where(eq(ledgerEntries.id, row!.id))).rejects.toThrow();
    await expect(db.delete(ledgerEntries).where(eq(ledgerEntries.id, row!.id))).rejects.toThrow();
    const [still] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.id, row!.id));
    expect(still?.debitCredits).toBe(5);
  });

  it('every row moves a positive amount on exactly one side', async () => {
    const db = await getDb();
    const a = await account();
    await expect(db.insert(ledgerEntries).values(entry(a, 0, 0))).rejects.toThrow();
    await expect(db.insert(ledgerEntries).values(entry(a, 3, 3))).rejects.toThrow();
    await expect(db.insert(ledgerEntries).values(entry(a, -3, 0))).rejects.toThrow();
  });

  it('idempotency keys are unique per credit account', async () => {
    const db = await getDb();
    const a = await account();
    const e = entry(a, 1, 0);
    await db.insert(ledgerEntries).values(e);
    await expect(db.insert(ledgerEntries).values({ ...e, id: uuidv7(), txnId: uuidv7() })).rejects.toThrow();
  });

  it('pool caches cannot go negative', async () => {
    const db = await getDb();
    await expect(db.update(pools).set({ availableCached: -1 }).where(eq(pools.slug, 'pool-verafy-dao-juries'))).rejects.toThrow();
  });

  it('volunteer rewards are null, never zero, at the task level', async () => {
    const db = await getDb();
    const r = await db.execute(sql`select conname from pg_constraint where conname = 'tasks_reward_check'`);
    expect((r as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });
});
