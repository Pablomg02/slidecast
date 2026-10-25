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

test('log in, upload, open only this room, redirect, delete', async ({ page, browser }) => {
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
  await expect(page.locator('tr[data-slug=demo2] td').first()).toHaveText('slidecast demo');

  // A new deck's room starts closed; "Open only this one" closes the others.
  await expect(page.locator('tr[data-slug=demo2] .room-toggle')).toHaveText('Closed');
  await page.click('tr[data-slug=demo2] .room-only');
  await expect(page.locator('tr[data-slug=demo2] .room-toggle')).toHaveText('Open');
  await expect(page.locator('tr[data-slug=demo] .room-toggle')).toHaveText('Closed');
  expect(srv.app.slidecast.rooms.isOpen('demo2')).toBe(true);
  expect(srv.app.slidecast.rooms.isOpen('legacy-pres')).toBe(false);

  // An anonymous visitor (no admin session) is sent to the open room.
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
  expect(srv.app.slidecast.config.rooms.demo2).toBe(undefined);
  for (const slug of ['demo', 'legacy-pres']) await srv.app.slidecast.rooms.update(slug, { open: true });
});

test('deck settings dialog sets a viewer password', async ({ page }) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('#password', 'admin-password');
  await page.click('button[type=submit]');
  await page.click('tr[data-slug=legacy-pres] button:has-text("Settings")');
  // The mode hint follows the select.
  await expect(page.locator('.deck-settings .mode-hint')).toContainText('not ahead of the presenter');
  await page.selectOption('#deck-mode', 'follow');
  await expect(page.locator('.deck-settings .mode-hint')).toContainText('cannot move');
  await expect(page.locator('.deck-settings button.primary')).toHaveText('Save changes');
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
  const site = new URL(srv.url).host;
  await expect(page.locator('.room-hint')).toContainText(`${site} opens the open room`);
  await expect(page.locator('label[for=public-listing]')).toContainText(`list of them at ${site}`);
  await expect(page.locator('.page-admin')).not.toContainText(' / ');
  await expect(page.locator('th', { hasText: 'Room' })).toBeVisible();
  await expect(page.locator('.password-control:has(#pw-admin-all) .hint'))
    .toContainText('slidecast passwd admin --clear');
  await expect(page.locator('#logout')).toBeVisible();
});

test('phone panel: decks as cards, nothing wider than the screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${srv.url}/admin`);
  await page.fill('#password', 'admin-password');
  await page.click('button[type=submit]');
  const card = page.locator('tr[data-slug=demo]');
  await expect(card).toBeVisible();
  await expect(page.locator('.deck-table thead')).toBeHidden();
  await expect(card.locator('.deck-room')).toContainText('Open');
  for (const name of ['Viewer', 'Presenter', 'Edit notes', 'Settings', 'Delete']) {
    const box = await card.getByText(name, { exact: true }).boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await context.close();
});

test('single-deck panel: the room is always open, no public list; no sign out without a password', async ({ browser }) => {
  const single = await startServer({ single: true });
  try {
    const context = await browser.newContext({ locale: 'es-ES' });
    const page = await context.newPage();
    await page.goto(`${single.url}/admin`); // local direct, no admin password
    await expect(page.locator('tr[data-slug=demo]')).toBeVisible();
    await expect(page.locator('#public-listing')).toHaveCount(0);
    await expect(page.locator('.room-toggle')).toBeDisabled();
    await expect(page.locator('.room-toggle')).toHaveText('Abierta');
    await expect(page.locator('.room-only')).toHaveCount(0);
    await expect(page.locator('#logout')).toHaveCount(0);
    await expect(page.locator('.password-control:has(#pw-admin-all) .hint'))
      .toHaveText('Sin ella, el panel de administración solo funciona en el ordenador donde corre Slidecast.');
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

test('appearance: site name, home message, accent, logo and credit', async ({ browser }) => {
  const own = await startServer();
  try {
    const context = await browser.newContext({ locale: 'es-ES' });
    const page = await context.newPage();
    await page.goto(`${own.url}/demo`);
    await expect(page.locator('.brand')).toHaveText('Slidecast');
    await expect(page.locator('.credit a')).toHaveAttribute('href', 'https://github.com/Pablomg02/slidecast');
    await expect(page.locator('.brand .brand-logo')).toHaveCount(1);

    await page.goto(`${own.url}/admin`); // local direct, no admin password
    await page.fill('#site-name', 'Charlas de Pablo');
    await page.fill('#landing-text', 'Pide el enlace en clase.');
    await page.locator('#accent-color').fill('#e11d48');
    await page.uncheck('#show-logo');
    await page.uncheck('#show-credit');
    await page.click('.appearance-form button[type=submit]');
    await expect(page.locator('.appearance-form .status')).toHaveText('Guardado');
    await expect(page).toHaveTitle('Administración · Charlas de Pablo');
    await expect(page.locator('#site-name')).toHaveValue('Charlas de Pablo');

    await page.goto(`${own.url}/demo`);
    await expect(page).toHaveTitle(/· Charlas de Pablo$/);
    await expect(page.locator('.brand')).toHaveText('Charlas de Pablo');
    await expect(page.locator('.brand .brand-logo')).toHaveCount(0);
    await expect(page.locator('.credit')).toHaveCount(0);
    await expect(page.locator('#app')).not.toContainText('null');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()))
      .toBe('#e11d48');
    await context.close();
  } finally {
    await own.close();
  }
});
