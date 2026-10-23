import { test, expect } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { startServer } from './server.js';

let srv;
test.beforeAll(async () => {
  srv = await startServer({ passwords: { admin: 'admin-password' } });
});
test.afterAll(async () => srv?.close());

async function demoZip() {
  const dir = join(import.meta.dirname, '..', '..', 'examples', 'demo');
  const files = {};
  for (const name of await readdir(dir)) files[`demo/${name}`] = new Uint8Array(await readFile(join(dir, name)));
  const path = join(srv.root, 'demo2.zip');
  await writeFile(path, zipSync(files));
  return path;
}

test('log in, upload, feature, redirect, delete', async ({ page, browser }) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('#password', 'nope-nope');
  await page.click('button[type=submit]');
  await expect(page.locator('.form-error')).toHaveText('Wrong password.');
  await page.fill('#password', 'admin-password');
  await page.click('button[type=submit]');
  await expect(page.locator('h1')).toContainText('Admin');

  await page.setInputFiles('#upload-file', await demoZip());
  await expect(page.locator('#upload-slug')).toHaveValue('demo2');
  await page.click('.upload-form button[type=submit]');
  await expect(page.locator('tr[data-slug=demo2]')).toBeVisible();
  await expect(page.locator('tr[data-slug=demo2] td').first()).toHaveText('syncdeck demo');

  await page.check('tr[data-slug=demo2] input[name=featured]');
  await expect.poll(() => srv.app.syncdeck.config.featured).toBe('demo2');

  // An anonymous visitor (no admin session) is sent to the featured deck.
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  await visitor.goto(`${srv.url}/`);
  await expect(visitor).toHaveURL(`${srv.url}/demo2`);
  await anon.close();
  // The admin is never redirected.
  await page.goto(`${srv.url}/`);
  await expect(page).toHaveURL(`${srv.url}/`);
  await page.goto(`${srv.url}/admin`);

  await page.click('tr[data-slug=demo2] button.danger');
  const confirm = page.locator('#confirm-delete');
  await expect(confirm).toBeDisabled();
  await page.fill('#confirm-slug', 'demo');
  await expect(confirm).toBeDisabled();
  await page.fill('#confirm-slug', 'demo2');
  await confirm.click();
  await expect(page.locator('tr[data-slug=demo2]')).toHaveCount(0);
  const trash = await readdir(join(srv.stateDir, 'trash'));
  expect(trash.some((n) => n.startsWith('demo2-'))).toBe(true);
  expect(srv.app.syncdeck.config.featured).toBe(null);
});

test('deck settings dialog sets a viewer password', async ({ page }) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('#password', 'admin-password');
  await page.click('button[type=submit]');
  await page.click('tr[data-slug=legacy-pres] button:has-text("Settings")');
  await page.fill('#pw-deckViewer-legacy-pres', 'viewer-secret1');
  await page.click('.password-control:has(#pw-deckViewer-legacy-pres) button:has-text("Set")');
  await expect(page.locator('.deck-settings .status.ok')).toHaveText('Saved');
  await page.click('.deck-settings button:has-text("Close")');
  // Seen through a tunnel (this browser is local direct, so it may present
  // and therefore view): the deck now asks for the viewer password.
  const res = await fetch(`${srv.url}/legacy-pres`, { redirect: 'manual', headers: { 'cf-connecting-ip': '203.0.113.9' } });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/legacy-pres/login?as=viewer');
});

test('multi-deck panel: listing hint, admin password removal hint, sign out', async ({ page }) => {
  await page.goto(`${srv.url}/admin`);
  await expect(page.locator('h1')).toHaveText('Admin sign-in');
  await page.fill('#password', 'admin-password');
  await page.click('button[type=submit]');
  await expect(page.locator('#public-listing')).toBeVisible();
  await expect(page.locator('.listing .hint')).toContainText('only shows a note asking for the link');
  await expect(page.locator('th', { hasText: 'Opens at /' })).toBeVisible();
  await expect(page.locator('.password-control:has(#pw-admin-all) .hint'))
    .toContainText('syncdeck passwd admin --clear');
  await expect(page.locator('#logout')).toBeVisible();
});

test('single-deck panel hides featured and the public list; no sign out without a password', async ({ browser }) => {
  const single = await startServer({ single: true });
  try {
    const context = await browser.newContext({ locale: 'es-ES' });
    const page = await context.newPage();
    await page.goto(`${single.url}/admin`); // local direct, no admin password
    await expect(page.locator('tr[data-slug=demo]')).toBeVisible();
    await expect(page.locator('#public-listing')).toHaveCount(0);
    await expect(page.locator('input[name=featured]')).toHaveCount(0);
    await expect(page.locator('th', { hasText: 'Destacada' })).toHaveCount(0);
    await expect(page.locator('#logout')).toHaveCount(0);
    await expect(page.locator('.password-control:has(#pw-admin-all) .hint'))
      .toHaveText('Sin ella, el panel de administración solo funciona en el ordenador donde corre syncdeck.');
    await context.close();
  } finally {
    await single.close();
  }
});

test('Spanish sign-in headings', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'es-ES' });
  const page = await context.newPage();
  await page.goto(`${srv.url}/admin`);
  await expect(page.locator('h1')).toHaveText('Entrar como administrador');
  await page.goto(`${srv.url}/demo/login?as=presenter`);
  await expect(page.locator('h1')).toHaveText('Entrar como presentador');
  await page.goto(`${srv.url}/demo/login?as=viewer`);
  await expect(page.locator('h1')).toHaveText('Entrar como espectador');
  await context.close();
});
