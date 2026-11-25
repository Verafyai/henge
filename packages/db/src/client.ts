import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * Database client. With DATABASE_URL set we use node-postgres (works with
 * Neon and local Postgres). Without it we use an embedded PGlite database in
 * <repo>/.data/pglite so the app runs with zero setup.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function repoRoot(start = process.cwd()): string {
  let dir = resolve(/* turbopackIgnore: true */ start);
  for (;;) {
    if (existsSync(join(/* turbopackIgnore: true */ dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(/* turbopackIgnore: true */ start);
    dir = parent;
  }
}

export function pgliteDir(): string {
  return process.env.PGLITE_DIR ?? join(/* turbopackIgnore: true */ repoRoot(), '.data', 'pglite');
}

async function createPgDb(url: string) {
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: url, max: 5 });
  return drizzle(pool, { schema });
}

async function createPgliteDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const dir = pgliteDir();
  // PGLITE_DIR=memory:// gives tests a throwaway in-memory database.
  if (!dir.startsWith('memory://')) mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  return drizzle(client, { schema });
}

const g = globalThis as unknown as { __swarmExplorerDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!g.__swarmExplorerDb) {
    const url = process.env.DATABASE_URL;
    g.__swarmExplorerDb = (url ? createPgDb(url) : createPgliteDb()) as Promise<Db>;
  }
  return g.__swarmExplorerDb;
}

export function usingPglite(): boolean {
  return !process.env.DATABASE_URL;
}
