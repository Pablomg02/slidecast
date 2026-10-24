import { test, expect } from '@playwright/test';
import { startServer } from './server.js';

// No passwords: the loopback browser is local direct and may present (D10).
let srv;
test.beforeAll(async () => { srv = await startServer(); });
test.afterAll(async () => srv?.close());

const frames = (page) => page.frames().filter((f) => f.url().includes('/_deck/'));
const currentOf = (f) => f.evaluate(() => window.SLIDECAST_DECK.current());
async function liveFrame(page) {
  return frames(page).find((f) => !f.url().includes('?static'));
}
async function nextFrame(page) {
  return frames(page).find((f) => f.url().includes('?static'));
}

async function openPresenter(page) {
  await page.goto(`${srv.url}/demo/present`);
  await expect(page.locator('#counter')).toHaveText(/^\d+ \/ 7$/);
}

test.beforeEach(async () => {
  const s = srv.socket('demo');
  await s.send({ t: 'goto', index: 0 });
  await s.state((m) => m.index === 0);
  s.close();
});

test('next advances the live index and the preview shows index+1', async ({ page }) => {
  await openPresenter(page);
  const viewer = srv.socket('demo', { role: 'viewer' });
  await page.click('#next');
  await viewer.state((s) => s.index === 1);
  await expect(page.locator('#counter')).toHaveText('2 / 7');
  await expect.poll(async () => currentOf(await liveFrame(page))).toBe(1);
  await expect.poll(async () => currentOf(await nextFrame(page))).toBe(2);
  await page.keyboard.press('PageDown');
  await viewer.state((s) => s.index === 2);
  await expect.poll(async () => currentOf(await nextFrame(page))).toBe(3);
  await page.click('#prev');
  await viewer.state((s) => s.index === 1);
  viewer.close();
});

test('the last step shows the End placeholder', async ({ page }) => {
  await openPresenter(page);
  await page.keyboard.press('End');
  await expect(page.locator('#counter')).toHaveText('7 / 7');
  await expect(page.locator('.p-end')).toBeVisible();
  await expect(page.locator('#next')).toBeDisabled();
});

test('notes for the slide and the step, updated by a notes message', async ({ page }) => {
  await openPresenter(page);
  await expect(page.locator('#notes')).toContainText('served by slidecast');
  await expect(page.locator('#notes strong')).toHaveText('served by slidecast');
  await page.click('#next');
  await page.click('#next');
  await expect(page.locator('#counter')).toHaveText('3 / 7');
  await expect(page.locator('#notes')).toContainText('Three steps on this slide');
  await expect(page.locator('.p-note-step')).toContainText('PageDown');
  const slides = (await srv.app.slidecast.decks.readMeta('demo')).slides;
  srv.app.slidecast.live.notifyNotes('demo', { ...slides, how: { notes: 'Fresh <b>note</b>', steps: { 1: 'Fresh step' } } });
  await expect(page.locator('#notes')).toContainText('Fresh <b>note</b>');
  await expect(page.locator('#notes b')).toHaveCount(0); // raw HTML is escaped
  await expect(page.locator('.p-note-step')).toHaveText('Fresh step');
});

test('the viewer-mode select changes viewerNav on a connected viewer', async ({ page }) => {
  await openPresenter(page);
  const viewer = srv.socket('demo', { role: 'viewer' });
  await page.selectOption('#viewer-mode', 'follow');
  await viewer.state((s) => s.viewerNav === 'follow');
  await page.selectOption('#viewer-mode', 'free');
  await viewer.state((s) => s.viewerNav === 'free');
  await page.selectOption('#viewer-mode', 'back');
  await viewer.state((s) => s.viewerNav === 'back');
  viewer.close();
});

test('blank toggles every viewer', async ({ page }) => {
  await openPresenter(page);
  const viewer = srv.socket('demo', { role: 'viewer' });
  await page.keyboard.press('b');
  await viewer.state((s) => s.blank === true);
  await page.click('#blank');
  await viewer.state((s) => s.blank === false);
  viewer.close();
});

test('timer starts, pauses and resets', async ({ page }) => {
  await openPresenter(page);
  await page.click('#timer-toggle');
  await expect(page.locator('#timer')).toHaveText('00:01', { timeout: 3000 });
  await page.click('#timer-toggle');
  await page.click('#timer-reset');
  await expect(page.locator('#timer')).toHaveText('00:00');
});

test('phone layout: big prev/next bar, no next preview', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openPresenter(page);
  const next = page.locator('#next');
  await expect(next).toBeVisible();
  await expect(page.locator('#prev')).toBeVisible();
  const box = await next.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(64);
  expect(box.y + box.height).toBeGreaterThan(844 - 120);
  await expect(page.locator('.p-next')).toBeHidden();
  expect(await nextFrame(page)).toBeUndefined();
  const viewer = srv.socket('demo', { role: 'viewer' });
  await next.tap();
  await viewer.state((s) => s.index === 1);
  viewer.close();
  await context.close();
});

test('phone layout: fits one screen, slide folds, extras open on demand', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openPresenter(page);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
  await expect(page.locator('#timer')).toBeVisible();
  await expect(page.locator('#clock')).toBeHidden();
  await expect(page.locator('#blank')).toBeHidden();
  await expect(page.locator('#viewer-mode')).toBeHidden();
  await page.locator('#more').tap();
  await expect(page.locator('#clock')).toBeVisible();
  await expect(page.locator('#blank')).toBeVisible();
  await expect(page.locator('#viewer-mode')).toBeVisible();
  const notesBefore = (await page.locator('.p-notes').boundingBox()).height;
  await page.locator('#slide-toggle').tap();
  await expect(page.locator('.p-current')).toBeHidden();
  expect((await page.locator('.p-notes').boundingBox()).height).toBeGreaterThan(notesBefore + 100);
  await page.reload();
  await expect(page.locator('.p-current')).toBeHidden(); // remembered
  await page.locator('#slide-toggle').tap();
  await expect(page.locator('.p-current')).toBeVisible();
  await context.close();
});

test('clicking a preview does not steal the keyboard', async ({ page }) => {
  await openPresenter(page);
  const viewer = srv.socket('demo', { role: 'viewer' });
  await page.locator('.p-current').click();
  await page.keyboard.press('ArrowRight');
  await viewer.state((s) => s.index === 1);
  await page.locator('.p-next').click();
  await page.keyboard.press('ArrowRight');
  await viewer.state((s) => s.index === 2);
  // Tab cannot move the focus into a preview either.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
  viewer.close();
});
