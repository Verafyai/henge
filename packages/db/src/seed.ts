import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, parseManifest, type ManifestV1 } from '@swarm-explorer/schema';
import { bundleDigest, generatePublisherKey, sha256Digest, signManifestV1 } from '@swarm-explorer/schema/node';
import { sql } from 'drizzle-orm';
import { getDb, repoRoot, usingPglite } from './client';
import {
  qualificationTasks,
  accounts,
  leaseRules,
  tasks,
  creditAccounts,
  economicConfigs,
  harnesses,
  harnessReleases,
  modelArtifacts,
  models,
  notificationPrefs,
  oauthClients,
  pools,
  publisherKeys,
  publishers,
  swarmReleases,
  swarms,
  verificationRules,
} from './schema';
import { seedAccounts, seedEconomicConfigV1, seedModels, seedOauthClients, seedPublisher, seedQualificationTasks, seedSwarmFiles, seedTasks } from './seed-data';
import { testOnlyDigest, testOnlyModels } from './seed-test-models';

export const FIXTURES = () => path.join(repoRoot(), 'packages', 'schema', 'fixtures');

/** Every table in the data model, truncated together. Local reset tooling only. */
const ALL_TABLES = [
  'outbox_events', 'device_nonces', 'license_acceptances', 'fit_calibrations', 'idempotency_records', 'client_releases', 'web_sessions', 'access_tokens', 'refresh_tokens', 'oauth_codes',
  'notifications', 'notification_prefs', 'share_cards', 'team_members', 'teams', 'account_badges', 'badges',
  'economic_configs', 'credit_purchases', 'ledger_entries', 'pools', 'credit_accounts',
  'receipts', 'platform_keys', 'verifier_nonces', 'verifier_keys', 'verification_rules', 'task_known_answers',
  'impact_events', 'reputation_events', 'verification_records', 'results', 'run_records', 'deadline_misses', 'lease_rules', 'leases', 'tasks',
  'qualification_attempts', 'qualification_tasks', 'qualifications', 'permission_grants', 'memberships',
  'revocations', 'reports', 'reviews', 'swarm_releases', 'swarms', 'harness_releases', 'harnesses',
  'node_models', 'model_artifacts', 'models', 'publisher_keys', 'publishers',
  'spend_caps', 'compute_sources', 'node_capabilities', 'nodes', 'installs', 'oauth_clients', 'account_identities', 'accounts',
];

const fileDigest = (p: string) => sha256Digest(readFileSync(p));

export function permissionsHash(m: ManifestV1): string {
  return sha256Digest(canonicalJson(m.permissions));
}

export function manifestHash(m: ManifestV1): string {
  return sha256Digest(canonicalJson(m));
}

/**
 * `testModels` adds the labelled test-only catalog entries (seed-test-models.ts) for the desktop e2e. It
 * defaults to `SEED_TEST_MODELS=1` and is refused outside the embedded test database.
 */
export async function seed(opts: { testModels?: boolean } = {}) {
  const testModels = opts.testModels ?? process.env['SEED_TEST_MODELS'] === '1';
  if (testModels && !usingPglite()) throw new Error('Test-only models are seeded only into the embedded PGlite database.');
  const db = await getDb();
  await db.execute(sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`));

  const acct = await db
    .insert(accounts)
    .values(
      seedAccounts.map((a) => ({
        handle: a.handle,
        displayName: a.displayName,
        platformRole: a.platformRole,
        emailHash: createHash('sha256').update(`${a.handle}@example.com`).digest('hex'),
      })),
    )
    .returning({ id: accounts.id, handle: accounts.handle });
  const accountId = new Map(acct.map((a) => [a.handle, a.id]));
  await db.insert(notificationPrefs).values(acct.map((a) => ({ accountId: a.id })));
  await db.insert(oauthClients).values(seedOauthClients);

  const [publisher] = await db
    .insert(publishers)
    .values({ slug: seedPublisher.slug, name: seedPublisher.name, ownerAccountId: accountId.get(seedPublisher.owner)!, badgeStatus: seedPublisher.badgeStatus })
    .returning();
  if (!publisher) throw new Error('publisher insert failed');

  // A fresh local test key on every seed. Its private half is discarded: seeded releases only
  // need to verify, and nothing here is a production signing key.
  const key = generatePublisherKey(`verafy-local-test-${Date.now()}`);
  await db.insert(publisherKeys).values({ publisherId: publisher.id, keyId: key.keyId, publicKey: key.publicKey });

  // The approved catalog carries its real pins. Test-only entries get a fixture digest of their label.
  const catalog = [
    ...seedModels.map((m) => ({ ...m, artifact: { ...m.artifact } })),
    ...(testModels ? testOnlyModels.map((m) => ({ ...m, artifact: { ...m.artifact, contentHash: sha256Digest(testOnlyDigest(m.slug, m.artifact.versionLabel)) } })) : []),
  ];
  for (const m of catalog) {
    const [row] = await db
      .insert(models)
      .values({ slug: m.slug, source: m.source, family: m.family, displayName: m.displayName, modelClass: m.modelClass, licenseId: m.licenseId, reviewStatus: 'approved' })
      .returning({ id: models.id });
    await db.insert(modelArtifacts).values({
      modelId: row!.id,
      ...m.artifact,
      runtimeFormats: m.source === 'ollama' ? ['ollama'] : ['gguf'],
      catalogVersion: 1,
    });
  }

  const platformAccount = await db.insert(creditAccounts).values({ ownerType: 'platform', ownerId: null }).returning();
  if (!platformAccount[0]) throw new Error('platform account insert failed');

  for (const file of seedSwarmFiles) {
    const parsed = parseManifest(readFileSync(path.join(FIXTURES(), 'manifests', 'valid', file), 'utf8'));
    if (!parsed.ok) throw new Error(`${file}: ${JSON.stringify(parsed.issues)}`);
    const manifest = signManifestV1(parsed.manifest, key);

    const bundleDir = path.join(FIXTURES(), 'harnesses', manifest.harness.name);
    const bundleHash = bundleDigest(bundleDir);
    if (bundleHash !== manifest.harness.hash) throw new Error(`${file}: harness hash does not match its fixture bundle`);
    const meta = JSON.parse(readFileSync(path.join(bundleDir, 'harness.json'), 'utf8')) as { min_model_class: string; output_schema: string; sbom: string };
    const releaseSig = sign(
      null,
      Buffer.from(canonicalJson({ publisher: manifest.publisher, name: manifest.harness.name, version: manifest.harness.version, bundle_hash: bundleHash })),
      createPrivateKey(key.privateKeyPem),
    ).toString('base64');

    const [harness] = await db.insert(harnesses).values({ publisherId: publisher.id, name: manifest.harness.name, reviewStatus: 'approved' }).returning();
    const [hr] = await db
      .insert(harnessReleases)
      .values({
        harnessId: harness!.id,
        version: manifest.harness.version,
        bundleHash,
        runtime: manifest.harness.runtime,
        minModelClass: meta.min_model_class,
        outputSchemaHash: fileDigest(path.join(bundleDir, meta.output_schema)),
        signature: `${key.keyId}:${releaseSig}`,
        sbomHash: fileDigest(path.join(bundleDir, meta.sbom)),
        reviewStatus: 'approved',
      })
      .returning();

    const [swarm] = await db
      .insert(swarms)
      .values({
        slug: manifest.id,
        publisherId: publisher.id,
        category: manifest.category,
        fundedMode: manifest.credits.funded ? 'funded' : 'volunteer',
        status: 'listed',
        featuredStatus: 'featured',
      })
      .returning();
    const [release] = await db.insert(swarmReleases).values({
      swarmId: swarm!.id,
      manifestVersion: manifest.manifest_version,
      manifestJson: manifest,
      manifestHash: manifestHash(manifest),
      harnessReleaseId: hr!.id,
      coordinatorConfig: manifest.coordinator,
      signature: manifest.signatures,
      permissionsHash: permissionsHash(manifest),
      reviewStatus: 'approved',
      publishedAt: new Date(),
    }).returning();

    // Lease rule version 1 (SPEC 7.3): no approved miss threshold and no renewals until Rex sets them.
    await db.insert(leaseRules).values({ swarmId: swarm!.id, version: 1, notes: 'No repeated-miss threshold or renewal limit approved yet. Misses are counted only.' });
    // Verification rule version 1 (SPEC 8.1, 9.2): no review window, redundancy count or jury panel
    // size is approved, so accepted work stays pending and those methods cannot decide yet.
    await db.insert(verificationRules).values({ swarmId: swarm!.id, version: 1, notes: 'No review window, redundancy count, jury panel size or known-answer rate approved yet. Manifest values are fixture illustrations.' });

    // Example queued tasks for the hosted coordinator (M5 demo path). Volunteer swarms carry no reward.
    const reward = manifest.credits.funded ? (manifest.credits.per_accepted_task ?? null) : null;
    const queued = seedTasks[manifest.id] ?? [];
    if (queued.length)
      await db.insert(tasks).values(
        queued.map((t) => ({
          swarmId: swarm!.id,
          releaseId: release!.id,
          coordinatorTaskId: t.id,
          inputRef: `coordinator:${manifest.id}/${t.id}`,
          inputHash: sha256Digest(canonicalJson(t.input)),
          inputJson: t.input,
          modelRequirementJson: { policy: manifest.models.policy, allowed_classes: manifest.models.class ? [manifest.models.class] : (manifest.models.allowed_classes ?? []) },
          rewardCredits: reward,
        })),
      );

    const known = seedQualificationTasks[manifest.id] ?? [];
    if (known.length !== manifest.qualification.tasks) throw new Error(`${file}: needs ${manifest.qualification.tasks} qualification tasks`);
    await db.insert(qualificationTasks).values(known.map((k) => ({ swarmId: swarm!.id, inputJson: k.input, expectedJson: k.expected, machineCheck: Boolean(k.machineCheck) })));

    if (manifest.credits.funded) {
      // Funded but empty: no pricing is approved, so nothing has been purchased (SPEC 9.6A).
      const [ca] = await db.insert(creditAccounts).values({ ownerType: 'pool', ownerId: swarm!.id }).returning();
      await db.insert(pools).values({ slug: manifest.credits.pool_id!, swarmId: swarm!.id, publisherId: publisher.id, creditAccountId: ca!.id, fundedMode: 'funded' });
    }
  }

  await db.insert(economicConfigs).values({ ...seedEconomicConfigV1, status: 'approved' });
  return { accounts: acct.length, swarms: seedSwarmFiles.length, models: catalog.length, publisherKeyId: key.keyId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then((r) => {
      console.log(`Seeded ${r.accounts} example accounts, ${r.swarms} launch swarms and ${r.models} catalog models.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
