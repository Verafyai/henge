import path from 'node:path';
import { test } from '@playwright/test';

/**
 * PR screenshots for henge.verafy.ai (spin-out spec section 13). Skipped unless LANDING_SHOTS_DIR
 * is set, for example: LANDING_SHOTS_DIR=/tmp/shots pnpm --filter @swarm-explorer/web e2e landing-shots
 */
const dir = process.env.LANDING_SHOTS_DIR;

const sizes = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;

test.skip(!dir, 'set LANDING_SHOTS_DIR to take screenshots');

for (const s of sizes) {
  test(`screenshots at ${s.name}`, async ({ page }) => {
    await page.setViewportSize({ width: s.width, height: s.height });
    for (const [route, slug] of [
      ['/', 'landing'],
      ['/download', 'download'],
      ['/spec', 'spec'],
      ['/glyphs', 'glyphs'],
      ['/s', 's'],
    ] as const) {
      await page.goto(route);
      await page.evaluate(() => document.fonts.ready);
      // Load lazy images before the full-page shot.
      await page.evaluate(async () => {
        for (const img of Array.from(document.images)) img.loading = 'eager';
        await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : new Promise((r) => img.addEventListener('load', r, { once: true })))));
      });
      await page.screenshot({ path: path.join(dir!, `${slug}-${s.name}.png`) });
      await page.screenshot({ path: path.join(dir!, `${slug}-${s.name}-full.png`), fullPage: true });
    }
  });
}
