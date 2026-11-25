import { rmSync } from 'node:fs';
import { pgliteDir, usingPglite } from './client';

// Local only: wipes the embedded database, then migrates and seeds.
if (!usingPglite()) {
  console.error('db:reset only runs against the embedded PGlite database. Unset DATABASE_URL.');
  process.exit(1);
}
rmSync(pgliteDir(), { recursive: true, force: true });
const { runMigrations } = await import('./migrate');
const { seed } = await import('./seed');
await runMigrations();
await seed();
console.log('Database reset, migrated and seeded.');
process.exit(0);
