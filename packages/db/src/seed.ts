import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, parseManifest, type ManifestV1 } from '@swarm-explorer/schema';
import { bundleDigest, generatePublisherKey, sha256Digest, signManifestV1 } from '@swarm-explorer/schema/node';
import { sql } from 'drizzle-orm';
import { getDb, repoRoot } from './client';
import {
  accounts,
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
} from './schema';
import { seedAccounts, seedEconomicConfigV1, seedModels, seedOauthClients, seedPublisher, seedSwarmFiles } from './seed-data';

export const FIXTURES = () => path.join(repoRoot(), 'packages', 'schema', 'fixtures');

/** Every table in the data model, truncated together. Local reset tooling only. */
const ALL_TABLES = [
  'outbox_events', 'device_nonces', 'license_acceptances', 'fit_calibrations', 'idempotency_records', 'client_releases', 'web_sessions', 'access_tokens', 'refresh_tokens', 'oauth_codes',
  'notifications', 'notification_prefs', 'share_cards', 'team_members', 'teams', 'account_badges', 'badges',
  'economic_configs', 'credit_purchases', 'ledger_entries', 'pools', 'credit_accounts',
  'impact_events', 'reputation_events', 'verification_records', 'results', 'run_records', 'leases', 'tasks',
  'qualifications', 'permission_grants', 'memberships',
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

export async function seed() {
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

  for (const m of seedModels) {
    const [row] = await db
      .insert(models)
      .values({ slug: m.slug, source: m.source, family: m.family, displayName: m.displayName, modelClass: m.modelClass, licenseId: m.licenseId, reviewStatus: 'approved' })
      .returning({ id: models.id });
    await db.insert(modelArtifacts).values({
      modelId: row!.id,
      ...m.artifact,
      contentHash: sha256Digest(`fixture-artifact:${m.slug}:${m.artifact.versionLabel}`),
      runtimeFormats: m.source === 'ollama' ? ['ollama'] : ['gguf'],
      catalogVersion: 0,
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
    await db.insert(swarmReleases).values({
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
    });

    if (manifest.credits.funded) {
      // Funded but empty: no pricing is approved, so nothing has been purchased (SPEC 9.6A).
      const [ca] = await db.insert(creditAccounts).values({ ownerType: 'pool', ownerId: swarm!.id }).returning();
      await db.insert(pools).values({ slug: manifest.credits.pool_id!, swarmId: swarm!.id, publisherId: publisher.id, creditAccountId: ca!.id, fundedMode: 'funded' });
    }
  }

  await db.insert(economicConfigs).values({ ...seedEconomicConfigV1, status: 'approved' });
  return { accounts: acct.length, swarms: seedSwarmFiles.length, models: seedModels.length, publisherKeyId: key.keyId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then((r) => {
      console.log(`Seeded ${r.accounts} example accounts, ${r.swarms} launch swarms and ${r.models} example models.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
