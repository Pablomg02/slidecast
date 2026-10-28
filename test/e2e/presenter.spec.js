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
  srv.app.slidecast.live.notifyNotes('demo', { ...slides, how: { notes: 'Fresh <b>note</b>, see example.com', steps: { 1: 'Fresh step' } } });
  await expect(page.locator('#notes')).toContainText('Fresh <b>note</b>');
  await expect(page.locator('#notes b')).toHaveCount(0); // raw HTML is escaped
  await expect(page.locator('#notes a')).toHaveAttribute('href', 'http://example.com'); // linkify, no scheme needed
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

const box = (page, sel) => page.locator(sel).boundingBox();
async function drag(page, sel, dx, dy) {
  const b = await box(page, sel);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test('dividers resize the slide, the next slide and the notes, and are remembered', async ({ page }) => {
  await openPresenter(page);
  await page.evaluate(() => localStorage.removeItem('slidecast.presenterSizes'));
  await page.reload();
  await expect(page.locator('#counter')).toHaveText(/^\d+ \/ 7$/);
  const current0 = await box(page, '.p-current');
  const next0 = await box(page, '.p-next');

  // Side column wider: smaller slide, bigger next slide, and the keys still move the slides.
  await drag(page, '.p-split-cols', -150, 0);
  const current1 = await box(page, '.p-current');
  const next1 = await box(page, '.p-next');
  const notes1 = await box(page, '.p-notes');
  expect(current1.width).toBeLessThan(current0.width - 100);
  expect(next1.width).toBeGreaterThan(next0.width + 100);
  expect(next1.width / next1.height).toBeCloseTo(16 / 9, 1);
  const viewer = srv.socket('demo', { role: 'viewer' });
  await page.keyboard.press('ArrowRight');
  await viewer.state((s) => s.index === 1);
  viewer.close();

  // Next slide shorter: more room for the notes.
  await drag(page, '.p-split-rows', 0, -120);
  const next2 = await box(page, '.p-next');
  const notes2 = await box(page, '.p-notes');
  expect(next2.height).toBeLessThan(next1.height - 80);
  expect(notes2.height).toBeGreaterThan(notes1.height + 80);

  // Remembered after a reload.
  await page.reload();
  await expect(page.locator('#counter')).toHaveText(/^\d+ \/ 7$/);
  expect(Math.abs((await box(page, '.p-next')).height - next2.height)).toBeLessThan(2);
  expect(Math.abs((await box(page, '.p-current')).width - current1.width)).toBeLessThan(2);

  // Double-click: the original layout.
  await page.locator('.p-split-rows').dblclick();
  expect(Math.abs((await box(page, '.p-current')).width - current0.width)).toBeLessThan(2);
  expect(Math.abs((await box(page, '.p-next')).height - next0.height)).toBeLessThan(2);
});

test('the next slide grows down to the notes minimum, widening its column', async ({ page }) => {
  await openPresenter(page);
  await page.locator('.p-split-rows').dblclick();
  const current0 = await box(page, '.p-current');
  await drag(page, '.p-split-rows', 0, 2000);
  const next = await box(page, '.p-next');
  const notes = await box(page, '.p-notes');
  const current = await box(page, '.p-current');
  expect(notes.height).toBeGreaterThanOrEqual(119);
  expect(current.width).toBeGreaterThanOrEqual(279);
  expect(current.width).toBeLessThan(current0.width);
  expect(next.width / next.height).toBeCloseTo(16 / 9, 1);
  // Nothing overflows, also in a smaller window.
  await page.setViewportSize({ width: 960, height: 600 });
  for (const sel of ['.p-current', '.p-next', '.p-notes', '.p-toolbar']) {
    const b = await box(page, sel);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(960);
    expect(b.y + b.height).toBeLessThanOrEqual(600);
  }
  expect((await box(page, '.p-notes')).height).toBeGreaterThanOrEqual(119);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(600);
  await page.locator('.p-split-cols').dblclick();
});

test('a divider reached with Tab resizes with the arrow keys, not the slide', async ({ page }) => {
  await openPresenter(page);
  await page.locator('.p-split-rows').dblclick();
  const viewer = srv.socket('demo', { role: 'viewer' });
  const before = (await box(page, '.p-next')).height;
  await page.locator('.p-split-rows').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  expect((await box(page, '.p-next')).height).toBeLessThan(before - 30);
  await expect(page.locator('#counter')).toHaveText('1 / 7');
  await expect(page.locator('.p-split-rows')).toHaveAttribute('aria-valuenow', /^\d+$/);
  // Other keys still reach the presentation.
  await page.keyboard.press('PageDown');
  await viewer.state((s) => s.index === 1);
  viewer.close();
  await page.locator('.p-split-rows').dblclick();
});
