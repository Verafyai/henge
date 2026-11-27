// Applies database migrations before a production build on Vercel, so new tables exist before new code serves.
// Preview and local builds skip it: previews must never migrate the production database with unmerged changes.
import { execFileSync } from 'node:child_process';

if (process.env.VERCEL_ENV !== 'production') {
  console.log('migrate-on-deploy: not a production deploy, skipping');
  process.exit(0);
}
// Migrations take locks and run in transactions, so use Neon's direct connection rather than the pooler.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('migrate-on-deploy: no DATABASE_URL on a production deploy; refusing to build against an embedded database');
  process.exit(1);
}
execFileSync('pnpm', ['--filter', '@swarm-explorer/db', 'migrate'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
console.log('migrate-on-deploy: migrations applied');
