import { test, expect } from '@playwright/test';
import { startServer } from './server.js';

// No passwords at all, seen from another device (a proxy header makes the
// browser not "local direct"): presenting and the admin panel are refused.
let srv;
test.beforeAll(async () => { srv = await startServer(); });
test.afterAll(async () => srv?.close());

test.use({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.50' }, locale: 'es-ES' });

test('presenter login without a configured password gives no hint about the server', async ({ page }) => {
  await page.goto(`${srv.url}/demo/present`);
  await expect(page).toHaveURL(/\/demo\/login\?as=presenter$/);
  await page.fill('#password', 'cualquier-cosa');
  await page.click('button[type=submit]');
  const error = page.locator('.form-error');
  await expect(error).toBeVisible();
  await expect(error).toHaveText('Todavía no se puede presentar desde este dispositivo.');
  await expect(error).not.toContainText('passwd');
});

test('admin login without a configured password gives no hint about the server', async ({ page }) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('#password', 'cualquier-cosa');
  await page.click('button[type=submit]');
  const error = page.locator('.form-error');
  await expect(error).toHaveText('El panel de administración no está disponible desde este dispositivo.');
  await expect(error).not.toContainText('passwd');
});
