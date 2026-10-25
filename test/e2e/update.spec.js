// Download and update decks (0004). Each test works on its own copy of the
// demo deck, so none depends on another.
import { test, expect } from '@playwright/test';
import { readFile, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { startServer } from './server.js';

let srv;
let session; // one admin sign-in for the whole file: sign-ins are rate limited
test.beforeAll(async () => {
  srv = await startServer({ passwords: { admin: 'admin-password' } });
  session = await srv.login('admin', 'admin-password');
});
test.afterAll(async () => srv?.close());


const DEMO = join(import.meta.dirname, '..', '..', 'examples', 'demo');

// A copy of the demo deck under its own name, and the admin panel showing it.
async function adminWithDeck(page, slug) {
  await cp(DEMO, join(srv.dataDir, slug), { recursive: true });
  await page.context().addCookies([{ name: 'sc_session', value: session, url: srv.url }]);
  await page.goto(`${srv.url}/admin`);
  await expect(page.locator(`tr[data-slug=${slug}]`)).toBeVisible();
}

// The demo deck as a zip buffer, with `edit(files)` applied first.
async function demoFiles(edit = () => {}) {
  const files = {};
  for (const name of await readdir(DEMO)) files[name] = new Uint8Array(await readFile(join(DEMO, name)));
  edit(files);
  return Buffer.from(zipSync(files));
}

const deckMeta = async (slug) => JSON.parse(await readFile(join(srv.dataDir, slug, 'deck.json'), 'utf8'));

test('download a deck with its notes', async ({ page }) => {
  await adminWithDeck(page, 'dl1');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('tr[data-slug=dl1] .download-link'),
  ]);
  expect(download.suggestedFilename()).toBe('dl1.zip');
  const files = unzipSync(new Uint8Array(await readFile(await download.path())));
  expect(Object.keys(files).sort()).toEqual((await readdir(DEMO)).sort());
  expect(Buffer.from(files['deck.json']).equals(await readFile(join(DEMO, 'deck.json')))).toBe(true);
});

test('update keeps notes by slide id and says what it deletes', async ({ page }) => {
  await adminWithDeck(page, 'upd1');
  const zip = await demoFiles((f) => {
    delete f['deck.json'];
    const html = Buffer.from(f['index.html']).toString()
      .replace('id="keys"', 'id="keys2"').replace('id="how" data-steps="3"', 'id="how" data-steps="2"');
    f['index.html'] = new TextEncoder().encode(html);
  });
  await page.click('tr[data-slug=upd1] .update-btn');
  await expect(page.locator('#update-confirm')).toBeDisabled();
  await page.setInputFiles('#update-file', { name: 'upd1.zip', mimeType: 'application/zip', buffer: zip });
  await page.click('#update-check');
  const outcome = page.locator('.update-outcome');
  await expect(outcome).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#update-confirm')).toBeEnabled();
  await expect(page.locator('.update-summary')).toContainText('keys');
  await expect(page.locator('.update-summary')).toContainText('how·2');
  await expect(outcome).toContainText('keys');
  await expect(outcome).toContainText('how·2');
  await expect(page.locator('.update-summary')).not.toContainText('null');
  await expect(page.locator('input[name=notes-source]')).toHaveCount(0);
  await page.click('#update-confirm');
  await expect(page.locator('.update-dialog')).toHaveCount(0);
  await expect(page.locator('.upload-form .status')).toHaveText('Updated.');
  const meta = await deckMeta('upd1');
  const demo = JSON.parse(await readFile(join(DEMO, 'deck.json'), 'utf8'));
  expect(meta.slides.keys).toBeUndefined();
  expect(meta.slides.keys2).toBeUndefined();
  expect(Object.keys(meta.slides.how.steps)).toEqual(['1']);
  expect(meta.slides.intro).toEqual(demo.slides.intro);
});

test('a zip with its own notes asks which ones to use', async ({ page }) => {
  await adminWithDeck(page, 'upd2');
  // The deck's own download, unchanged: nothing to choose.
  const same = await (await page.request.get(`${srv.url}/api/admin/decks/upd2/download`)).body();
  await page.click('tr[data-slug=upd2] .update-btn');
  await page.setInputFiles('#update-file', { name: 'upd2.zip', mimeType: 'application/zip', buffer: same });
  await page.click('#update-check');
  await expect(page.locator('.update-outcome')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('input[name=notes-source]')).toHaveCount(0);
  await page.click('.update-dialog button:has-text("Close")');
  await expect(page.locator('.update-dialog')).toHaveCount(0);

  const zip = await demoFiles((f) => {
    const meta = JSON.parse(Buffer.from(f['deck.json']).toString());
    meta.title = 'Brand new title';
    f['deck.json'] = new TextEncoder().encode(JSON.stringify(meta));
  });
  await page.click('tr[data-slug=upd2] .update-btn');
  await page.setInputFiles('#update-file', { name: 'upd2.zip', mimeType: 'application/zip', buffer: zip });
  await page.click('#update-check');
  await expect(page.locator('input[name=notes-source]')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator('.update-outcome')).toContainText("The zip's deck.json is ignored.");
  await page.check('input[name=notes-source][value=incoming]');
  await expect(page.locator('.update-outcome')).toContainText("come from the zip's deck.json");
  await page.click('#update-confirm');
  await expect(page.locator('tr[data-slug=upd2] td').first()).toHaveText('Brand new title');
  expect((await deckMeta('upd2')).title).toBe('Brand new title');
});

test('the upload form over an existing name opens the update', async ({ page }) => {
  await adminWithDeck(page, 'upd3');
  await page.setInputFiles('#upload-file', { name: 'upd3.zip', mimeType: 'application/zip', buffer: await demoFiles() });
  await expect(page.locator('#upload-slug')).toHaveValue('upd3');
  await page.click('.upload-form button[type=submit]');
  await expect(page.locator('.update-dialog')).toBeVisible();
  await expect(page.locator('.update-file-name')).toHaveText('upd3.zip');
  await expect(page.locator('.update-outcome')).toBeVisible({ timeout: 20_000 });
});

test('the info button explains how updating works', async ({ page }) => {
  await adminWithDeck(page, 'info1');
  const info = page.locator('#update-info');
  const button = page.locator('tr[data-slug=info1] .update-info-btn');
  await button.click();
  await expect(info).toBeVisible();
  await expect(info).toContainText("Notes belong to a slide's id");
  await button.click();
  await expect(info).toBeHidden();
  await button.click();
  await expect(info).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(info).toBeHidden();
  await page.click('tr[data-slug=info1] button:has-text("Settings")');
  await page.click('.deck-settings button:has-text("Close")');
  await expect(page.locator('.deck-settings')).toHaveCount(0);
  await page.locator('tr[data-slug=info1] .update-info-btn').click();
  await expect(info).toBeVisible();
});
