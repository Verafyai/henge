import { expect, test, type Page } from '@playwright/test';
import { download, glyphDirectory, hero, landingHeadings, nav, pasteLink } from '../lib/henge-landing-copy';

/** henge.verafy.ai landing and its routes (Henge spin-out spec v2, section 5.2). */

async function noHorizontalScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(client);
}

test('landing: H1, hero buttons, every section heading and the nav anchors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(hero.h1Lead + hero.h1Accent);
  const heroBox = page.locator('.hg-hero');
  await expect(heroBox.getByRole('link', { name: hero.primary.label })).toHaveAttribute('href', '/download');
  await expect(heroBox.getByRole('link', { name: hero.secondary.label })).toHaveAttribute('href', '/s');
  await expect(heroBox.getByText(hero.note)).toBeVisible();
  for (const name of landingHeadings) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  const main = page.getByRole('navigation', { name: 'Main' });
  for (const l of nav.links) await expect(main.getByRole('link', { name: l.label, exact: true })).toHaveAttribute('href', l.href);
  for (const id of ['how-it-works', 'glyphs', 'henge-file', 'science']) await expect(page.locator(`#${id}`)).toHaveCount(1);
});

test('landing: mockup images are labeled as design previews', async ({ page }) => {
  await page.goto('/');
  const previews = page.locator('[data-design-preview]');
  await expect(previews).toHaveCount(2);
  for (const fig of await previews.all()) await expect(fig.locator('figcaption')).toContainText('Design preview');
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/[\u2013\u2014]/);
});

test('landing: no horizontal scroll at 390px, and the hero still has both buttons', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await noHorizontalScroll(page);
  const heroBox = page.locator('.hg-hero');
  await expect(heroBox.getByRole('link', { name: hero.primary.label })).toBeVisible();
  await expect(heroBox.getByRole('link', { name: hero.secondary.label })).toBeVisible();
  for (const path of ['/download', '/spec', '/glyphs', '/s']) {
    await page.goto(path);
    await noHorizontalScroll(page);
  }
});

test('download, spec, glyphs and the link preview answer 200', async ({ page }) => {
  for (const path of ['/download', '/spec', '/glyphs', '/s', '/s?url=https%3A%2F%2Fexample.com%2Fa.henge']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
  }
});

test('download offers nothing fake: disabled buttons, no links to a release, no versions', async ({ page }) => {
  await page.goto('/download');
  for (const p of download.platforms) {
    const card = page.locator(`[data-platform="${p.name}"]`);
    await expect(card.getByRole('button', { name: p.status })).toBeDisabled();
    await expect(card.getByRole('link')).toHaveCount(0);
  }
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/\d/);
  await expect(page.locator('a[href*="/releases"]')).toHaveCount(0);
});

test('spec renders sections 6 and 7; glyphs lists the six built-ins; /s is disabled', async ({ page }) => {
  await page.goto('/spec');
  await expect(page.getByRole('heading', { level: 2, name: '7. Workstream D: Glyphs and Runes' })).toBeVisible();
  await expect(page.locator('.hg-doc table')).toHaveCount(2);
  await page.goto('/glyphs');
  await expect(page.locator('[data-glyph]')).toHaveCount(6);
  for (const g of glyphDirectory.items) await expect(page.getByRole('heading', { level: 2, name: g.name })).toBeVisible();
  await page.goto('/s');
  await expect(page.getByLabel(pasteLink.label)).toBeDisabled();
  await expect(page.getByRole('button', { name: pasteLink.status })).toBeDisabled();
});

test('an unknown path is a 404 in the Henge style', async ({ page }) => {
  const res = await page.goto('/no-such-page');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('link', { name: 'Back to Henge' })).toHaveAttribute('href', '/');
});
