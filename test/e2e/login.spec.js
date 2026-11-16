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

test.describe('with a viewer password', () => {
  let pw;
  test.beforeAll(async () => { pw = await startServer({ passwords: { 'viewer:demo': 'clase-2026' } }); });
  test.afterAll(async () => pw?.close());

  test('too many tries in a row: the page says when to retry and counts down', async ({ page }) => {
    await page.goto(`${pw.url}/demo/login?as=viewer`);
    const button = page.locator('button[type=submit]');
    const error = page.locator('.form-error');
    for (let i = 0; i < 3; i++) {
      await page.fill('#password', `mal-${i}`);
      await button.click();
      await expect(error).toHaveText('Contraseña incorrecta.');
      await expect(button).toBeEnabled();
    }
    await page.fill('#password', 'clase-2026');
    await button.click();
    await expect(error).toHaveText(/^Demasiados intentos\. Podrás volver a probar en [1-5] s\.$/);
    await expect(button).toBeDisabled();
    await expect(button).toHaveText(/^Espera [1-5] s$/);
    await expect(button).toHaveText('Entrar', { timeout: 7000 });
    await expect(button).toBeEnabled();
    await expect(error).toBeHidden();
    await button.click();
    await expect(page).toHaveURL(/\/demo\/view$/);
  });
});
