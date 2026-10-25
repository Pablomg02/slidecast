import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { startServer } from './server.js';

let srv;
let presenter;
let presenterCookie;
test.beforeAll(async () => {
  // Both passwords set: otherwise the loopback browser is local direct (D10) and may present.
  srv = await startServer({ passwords: { presenter: 'presenter-pass', admin: 'admin-password' } });
  // One login for the whole file: the login rate limit allows 5 per minute.
  presenterCookie = await srv.login('presenter', 'presenter-pass');
});
test.afterAll(async () => {
  presenter?.close();
  await srv?.close();
});

const deckFrame = (page) => page.frames().find((f) => f.url().includes('/_deck/'));
const current = (page) => deckFrame(page).evaluate(() => window.SLIDECAST_DECK.current());

// The presenter's socket sees a mode change before the viewer page does.
const viewerNav = (page, mode) => expect(page.locator('body')).toHaveAttribute('data-nav', mode);

async function openViewer(page) {
  // Joined anonymously before: no name prompt takes the keyboard.
  await page.addInitScript(() => localStorage.setItem('slidecast.name', '{"name":null}'));
  await page.goto(`${srv.url}/demo/view`);
  await expect.poll(() => deckFrame(page)?.evaluate(() => Boolean(window.SLIDECAST_DECK)).catch(() => false)).toBe(true);
  // The shell keeps the focus after load, so page.keyboard reaches it (a click
  // would land in the deck and count as "next").
}

// Reset the live state before each test.
test.beforeEach(async () => {
  presenter?.close();
  presenter = srv.socket('demo', { cookie: presenterCookie });
  await presenter.send({ t: 'meta', total: 7 });
  await presenter.send({ t: 'goto', index: 0 });
  await presenter.send({ t: 'blank', on: false });
  await presenter.send({ t: 'nav', mode: 'back' });
  await presenter.state((s) => s.index === 0 && !s.blank && s.viewerNav === 'back');
});

test('a presenter step moves the viewer within 1 s', async ({ page }) => {
  await openViewer(page);
  await expect(page.locator('.badge-control')).toBeHidden();
  await presenter.send({ t: 'step', delta: 1 });
  const t0 = Date.now();
  await expect.poll(() => current(page), { timeout: 1000 }).toBe(1);
  expect(Date.now() - t0).toBeLessThan(1000);
});

test('follow: the viewer cannot move', async ({ page }) => {
  await openViewer(page);
  await presenter.send({ t: 'nav', mode: 'follow' });
  await presenter.state((s) => s.viewerNav === 'follow');
  await viewerNav(page, 'follow');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.nav-hint')).toHaveText('The presenter controls the slides: you cannot move.');
  await page.keyboard.press('ArrowLeft');
  // Keys pressed inside the deck are forwarded too, and ignored as well.
  await deckFrame(page).evaluate(() => window.focus());
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  expect(await current(page)).toBe(0);
});

test('back: may go back, never past live; "Back to live" re-attaches', async ({ page }) => {
  await openViewer(page);
  await presenter.send({ t: 'goto', index: 3 });
  await expect.poll(() => current(page)).toBe(3);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => current(page)).toBe(1);
  const live = page.getByRole('button', { name: 'Back to live' });
  await expect(live).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => current(page)).toBe(3);
  await expect(page.locator('.nav-hint')).toHaveText('You cannot go ahead of the presenter.');
  await page.waitForTimeout(200);
  expect(await current(page)).toBe(3);
  await expect(live).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => current(page)).toBe(2);
  // While detached, a presenter step does not drag the viewer.
  await presenter.send({ t: 'step', delta: 1 });
  await presenter.state((s) => s.index === 4);
  await page.waitForTimeout(200);
  expect(await current(page)).toBe(2);
  await live.click();
  await expect.poll(() => current(page)).toBe(4);
  await expect(live).toBeHidden();
});

test('free: the viewer can go ahead of live', async ({ page }) => {
  await openViewer(page);
  await presenter.send({ t: 'nav', mode: 'free' });
  await presenter.state((s) => s.viewerNav === 'free');
  await viewerNav(page, 'free');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => current(page)).toBe(2);
  await expect(page.locator('.nav-hint')).toBeHidden();
  await page.keyboard.press('l');
  await expect.poll(() => current(page)).toBe(0);
});

test('switching to follow re-attaches a detached viewer', async ({ page }) => {
  await openViewer(page);
  await presenter.send({ t: 'nav', mode: 'free' });
  await presenter.state((s) => s.viewerNav === 'free');
  await viewerNav(page, 'free');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => current(page)).toBe(1);
  await presenter.send({ t: 'nav', mode: 'follow' });
  await expect.poll(() => current(page)).toBe(0);
});

test('no presenter: a quiet notice, closable, gone when one comes back', async ({ page }) => {
  await openViewer(page);
  const notice = page.locator('.no-presenter');
  await page.waitForTimeout(500);
  await expect(notice).toBeHidden();
  presenter.close();
  await expect(notice).toHaveText(/There is no presenter at the moment\./);
  presenter = srv.socket('demo', { cookie: presenterCookie });
  await expect(notice).toBeHidden();
  presenter.close();
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Close' }).click();
  await expect(notice).toBeHidden();
  presenter = srv.socket('demo', { cookie: presenterCookie });
  await presenter.state((s) => s.presenting);
  presenter.close();
  await expect(notice).toBeVisible(); // closed by hand only until a presenter came back
});

test('blank shows the overlay', async ({ page }) => {
  await openViewer(page);
  const overlay = page.locator('.blank-overlay');
  await expect(overlay).toBeHidden();
  await presenter.send({ t: 'blank', on: true });
  await expect(overlay).toBeVisible();
  await presenter.send({ t: 'blank', on: false });
  await expect(overlay).toBeHidden();
});

test('a viewer page with a presenter session drives the live index', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'sc_session', value: presenterCookie, url: srv.url }]);
  const page = await context.newPage();
  await openViewer(page);
  await expect(page.locator('.badge-control')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await presenter.state((s) => s.index === 1);
  await expect.poll(() => current(page)).toBe(1);
  // The clicker's "black screen" key works from the projector too.
  await page.keyboard.press('b');
  await presenter.state((s) => s.blank === true);
  await context.close();
});

test('a controlling viewer can stop and resume controlling', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'sc_session', value: presenterCookie, url: srv.url }]);
  const page = await context.newPage();
  await openViewer(page);
  await expect(page.locator('.badge-control')).toBeVisible();
  await page.locator('.control-toggle').click();
  await expect(page).toHaveURL(/control=off/);
  await expect.poll(() => deckFrame(page)?.evaluate(() => Boolean(window.SLIDECAST_DECK)).catch(() => false)).toBe(true);
  await expect(page.locator('.badge-control')).toBeHidden();
  await expect(page.locator('.control-toggle')).toHaveText('Control');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowRight'); // a plain viewer in "back" mode cannot go ahead
  await page.waitForTimeout(500);
  await page.locator('.control-toggle').click();
  await expect(page).not.toHaveURL(/control=off/);
  await expect.poll(() => deckFrame(page)?.evaluate(() => Boolean(window.SLIDECAST_DECK)).catch(() => false)).toBe(true);
  await expect(page.locator('.badge-control')).toBeVisible();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowRight');
  const s = await presenter.state((x) => x.index >= 1);
  assert.equal(s.index, 1);
  await context.close();
});

test('Spanish UI when the browser prefers it', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'es-ES' });
  const page = await context.newPage();
  await page.goto(`${srv.url}/demo`);
  await expect(page.locator('#go-viewer .mode-name')).toHaveText('Espectador');
  await expect(page.locator('#go-presenter .mode-name')).toHaveText('Presentador');
  await context.close();
  const en = await browser.newContext({ locale: 'en-GB' });
  const p2 = await en.newPage();
  await p2.goto(`${srv.url}/demo`);
  await expect(p2.locator('#go-viewer .mode-name')).toHaveText('Viewer');
  await en.close();
});

test('the login page signs a presenter in', async ({ page }) => {
  await page.goto(`${srv.url}/demo/present`);
  await expect(page).toHaveURL(/\/demo\/login\?as=presenter$/);
  await page.fill('#password', 'wrong-password');
  await page.click('button[type=submit]');
  await expect(page.locator('.form-error')).toHaveText('Wrong password.');
  await page.fill('#password', 'presenter-pass');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/demo\/present$/);
});
