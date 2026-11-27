import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
/** The web suite owns its database too: wiped, migrated and seeded on every run (see the client config). */
const E2E_DB = fileURLToPath(new URL('../../.data/pglite-e2e-web', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `pnpm --filter @swarm-explorer/db reset && pnpm start --port ${PORT}`,
    // DEV_SIGN_IN lets the community e2e sign in two example users through the real OAuth flow.
    // HENGE_PREVIEW_ALLOW_LOCALHOST lets /s fetch the example from this test server over http. Test
    // only: both are ignored whenever VERCEL is set.
    env: { PGLITE_DIR: E2E_DB, DATABASE_URL: '', DEV_SIGN_IN: '1', HENGE_PREVIEW_ALLOW_LOCALHOST: '1' },
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
