/** Test helpers for the community layer. Tests only. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, repoRoot } from '../client';
import { accounts, installs } from '../schema';
import type { Actor } from './context';
import { upsertProfile } from './profiles';

export const EXAMPLE_HENGE_PATH = () => path.join(repoRoot(), 'packages', 'schema', 'fixtures', 'henge', 'valid', 'example.henge.yaml');

/**
 * The spec's example `.henge` file with open admission (the example asks for review, which this layer
 * does not build yet) and the given holders. Everything else, including the community block, the
 * Moderation Glyph Runes and the rate limits, is the example as written.
 */
export function exampleHengeSource(opts: { id?: string; owner?: string; maintainer?: string; mod?: string } = {}): string {
  let src = readFileSync(EXAMPLE_HENGE_PATH(), 'utf8');
  src = src.replace(/^ {2}mode: request(\s)/m, '  mode: open$1');
  if (opts.id) src = src.replace(/^id: example-org\/resolved-forecasts/m, `id: ${opts.id}`);
  if (opts.owner) src = src.replace('owner: [example-owner]', `owner: [${opts.owner}]`);
  if (opts.maintainer) src = src.replace('maintainer: [example-maintainer-1, example-maintainer-2]', `maintainer: [${opts.maintainer}]`);
  if (opts.mod) src = src.replace('mod: [example-mod-1]', `mod: [${opts.mod}]`);
  return src;
}

/** An account with a community profile. `ageMs` back-dates the account (new-account rules). */
export async function makeHuman(handle: string, opts: { ageMs?: number; profile?: boolean } = {}): Promise<Actor> {
  const db = await getDb();
  const createdAt = new Date(Date.now() - (opts.ageMs ?? 30 * 86_400_000));
  const [a] = await db.insert(accounts).values({ handle, displayName: handle, createdAt }).returning();
  if (opts.profile !== false) await upsertProfile(a!.id, { handle: handle.replace(/-/g, '_'), display_name: handle });
  return { type: 'human', id: a!.id, accountId: a!.id, accountCreatedAt: createdAt };
}

/** An install (device key holder) for an account, as the OAuth exchange would create. */
export async function makeInstall(accountId: string, devicePublicKey = 'test-device-key') {
  const db = await getDb();
  const [i] = await db
    .insert(installs)
    .values({ accountId, clientId: 'swarm-explorer-desktop', platform: 'darwin', arch: 'arm64', clientVersion: '0.2.0', channel: 'dev', devicePublicKey })
    .returning();
  return i!;
}

export async function accountCreatedAt(accountId: string) {
  const db = await getDb();
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return a!.createdAt;
}
