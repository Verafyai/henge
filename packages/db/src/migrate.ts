import { fileURLToPath } from 'node:url';
import { getDb, usingPglite } from './client';

export async function runMigrations() {
  const db = await getDb();
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  if (usingPglite()) {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(db as never, { migrationsFolder });
  } else {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db as never, { migrationsFolder });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied.');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
