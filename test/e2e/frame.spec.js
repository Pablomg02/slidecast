// The frozen deck frame (0010): createDeckFrame with `virtual` draws the deck
// at a fixed size, scaled and centred, with an overlay layer on top of it.
import { test, expect } from '@playwright/test';
import { startServer } from './server.js';

let srv;
test.beforeAll(async () => { srv = await startServer(); });
test.afterAll(async () => srv?.close());

// Every message the page posts to the deck, recorded inside the deck itself.
async function openFrameHarness(page) {
  await page.addInitScript(() => {
    if (!location.pathname.startsWith('/_deck/')) return;
    window.__got = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.sd === 1) window.__got.push(e.data); });
  });
  await page.goto(`${srv.url}/__test/frame.html?deck=${encodeURIComponent(srv.deckUrl('demo'))}`);
  await page.waitForFunction(() => window.__ready === true);
}

const deckFrame = (page) => page.frames().find((f) => f.url().includes('/_deck/'));
const rect = (page, sel) => page.locator(sel).evaluate((n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const setBox = (page, w, h) => page.evaluate(([bw, bh]) => {
  const box = document.getElementById('box');
  box.style.width = `${bw}px`;
  box.style.height = `${bh}px`;
}, [w, h]);

function near(a, b, tol = 1) {
  for (const k of ['x', 'y', 'w', 'h']) expect(Math.abs(a[k] - b[k]), `${k}: ${a[k]} vs ${b[k]}`).toBeLessThanOrEqual(tol);
}

test('a virtual frame lays the deck out at its fixed size, scaled and centred', async ({ page }) => {
  await openFrameHarness(page);
  await page.evaluate(() => window.mount({ mode: 'live', virtual: { w: 1920, h: 1080 } }));
  const frame = deckFrame(page);
  expect(await frame.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
  const shown = await rect(page, '.deck-virtual');
  expect(Math.abs(shown.w - 390)).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.h - 219.375)).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.y - (844 - shown.h) / 2)).toBeLessThanOrEqual(1);
  near(await rect(page, '.deck-layer'), await rect(page, '.deck-frame'));
  expect(await page.locator('.deck-frame').getAttribute('allow')).toBe('autoplay');
  // The scale reaches the bridge in the mode message.
  await expect.poll(() => frame.evaluate(() => window.__got.filter((m) => m.t === 'mode').at(-1)?.scale))
    .toBeCloseTo(390 / 1920, 5);

  await setBox(page, 844, 390);
  await expect.poll(async () => (await rect(page, '.deck-virtual')).h).toBeCloseTo(390, 0);
  const wide = await rect(page, '.deck-virtual');
  expect(Math.abs(wide.x - (844 - wide.w) / 2)).toBeLessThanOrEqual(1);
  near(await rect(page, '.deck-layer'), await rect(page, '.deck-frame'));
  await expect.poll(() => frame.evaluate(() => window.__got.filter((m) => m.t === 'mode').at(-1)?.scale))
    .toBeCloseTo(390 / 1080, 5);
  expect(await frame.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
});

// The deck asks for full screen from a real mouse press (a user gesture).
async function fullscreenFromDeck(page) {
  const frame = deckFrame(page);
  await frame.evaluate(() => {
    window.__fs = new Promise((resolve) => {
      document.addEventListener('pointerdown', () => {
        document.documentElement.requestFullscreen().then(() => resolve('ok'), (e) => resolve(`rejected ${e.name}`));
      }, { once: true });
    });
  });
  const r = await page.locator('.deck-frame').boundingBox();
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  const result = await frame.evaluate(() => window.__fs);
  await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
  return result;
}

test('a frozen deck cannot take itself full screen; a normal one still can', async ({ page }) => {
  await openFrameHarness(page);
  await page.evaluate(() => window.mount({ mode: 'live' }));
  expect(await fullscreenFromDeck(page)).toBe('ok');
  await page.evaluate(() => window.mount({ mode: 'live', virtual: { w: 1920, h: 1080 } }));
  expect(await fullscreenFromDeck(page)).toMatch(/^rejected/);
});

test('without virtual, the frame is exactly as before', async ({ page }) => {
  await openFrameHarness(page);
  await page.evaluate(() => window.mount({ mode: 'live' }));
  const frame = deckFrame(page);
  expect(await page.locator('#box > iframe.deck-frame').count()).toBe(1);
  expect(await page.locator('.deck-virtual, .deck-layer').count()).toBe(0);
  expect(await page.locator('.deck-frame').getAttribute('allow')).toContain('fullscreen');
  expect(await frame.evaluate(() => [innerWidth, innerHeight])).toEqual([390, 844]);
  await expect.poll(() => frame.evaluate(() => window.__got.filter((m) => m.t === 'mode').length)).toBeGreaterThan(0);
  await page.evaluate(() => window.frame.setMode('preview'));
  await expect.poll(() => frame.evaluate(() => window.__got.at(-1)?.mode)).toBe('preview');
  const modes = await frame.evaluate(() => window.__got.filter((m) => m.t === 'mode'));
  for (const m of modes) expect(Object.hasOwn(m, 'scale')).toBe(false);
  expect(await page.evaluate(() => [window.frame.box, window.frame.layer, window.frame.scale])).toEqual([null, null, 1]);
});

test('destroy removes the wrapper and the layer', async ({ page }) => {
  await openFrameHarness(page);
  await page.evaluate(() => window.mount({ mode: 'live', virtual: { w: 1920, h: 1080 } }));
  await page.evaluate(() => window.frame.destroy());
  expect(await page.locator('#box *').count()).toBe(0);
});
