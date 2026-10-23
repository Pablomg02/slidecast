import { test, expect } from '@playwright/test';
import { startServer } from './server.js';

let srv;
test.beforeAll(async () => {
  srv = await startServer({
    extraDecks: { noapi: '<!doctype html><html><head><title>x</title></head><body><p>No API here</p></body></html>' },
  });
});
test.afterAll(async () => srv?.close());

async function openHarness(page, slug) {
  await page.goto(`${srv.url}/__test/harness.html?deck=${encodeURIComponent(srv.deckUrl(slug))}`);
  await expect.poll(() => page.evaluate(() => window.__msgs.find((m) => m.t === 'ready' || m.t === 'error')),
    { timeout: 5000 }).toBeTruthy();
  const frame = page.frames().find((f) => f.url().includes('/_deck/'));
  return frame;
}

// Keys go to the iframe only once its window has focus (as after a user click).
async function pressInFrame(page, frame, key) {
  await frame.evaluate(() => window.focus());
  await page.keyboard.press(key);
}

const msgs = (page) => page.evaluate(() => window.__msgs);
const clearMsgs = (page) => page.evaluate(() => { window.__msgs.length = 0; });

const DECKS = [
  {
    slug: 'demo',
    adapter: 'native',
    steps: [['intro', 0], ['how', 0], ['how', 1], ['how', 2], ['roles', 0], ['keys', 0], ['end', 0]],
    current: () => window.SYNCDECK_DECK.current(),
    // index 3 = how:2 — the slide is shown with both step lines revealed
    visibleAt3: async (frame) => {
      await expect(frame.locator('#how')).toBeVisible();
      await expect(frame.locator('#how [data-step="2"]')).toHaveClass(/shown/);
    },
  },
  {
    slug: 'legacy-pres',
    adapter: 'legacy',
    steps: [['portada', 0], ['intro', 0], ['intro', 1], ['intro', 2], ['lista', 0], ['lista', 1],
      ['lista', 2], ['lista', 3], ['tabla', 0], ['tabla', 2], ['fin', 0]],
    current: () => window.PRES.actual(),
    visibleAt3: async (frame) => {
      await expect(frame.locator('#intro')).toBeVisible();
      await expect(frame.locator('#intro-2')).toBeVisible();
    },
  },
];

for (const deck of DECKS) {
  test.describe(`${deck.adapter} adapter (${deck.slug})`, () => {
    test('ready lists the steps', async ({ page }) => {
      await openHarness(page, deck.slug);
      const ready = (await msgs(page)).find((m) => m.t === 'ready');
      expect(ready.adapter).toBe(deck.adapter);
      expect(ready.index).toBe(0);
      expect(ready.steps).toEqual(deck.steps.map(([slide, step]) => ({ slide, step })));
    });

    test('go moves the deck and reports changed', async ({ page }) => {
      const frame = await openHarness(page, deck.slug);
      await clearMsgs(page);
      await page.evaluate(() => window.send({ t: 'go', index: 3 }));
      await expect.poll(async () => (await msgs(page)).some((m) => m.t === 'changed' && m.index === 3)).toBe(true);
      expect(await frame.evaluate(deck.current)).toBe(3);
      await deck.visibleAt3(frame);
    });

    test('ArrowRight is captured and forwarded, the deck does not move', async ({ page }) => {
      const frame = await openHarness(page, deck.slug);
      await clearMsgs(page);
      await pressInFrame(page, frame, 'ArrowRight');
      await expect.poll(async () => (await msgs(page)).filter((m) => m.t === 'input')).toEqual(
        [{ sd: 1, t: 'input', action: 'next' }]);
      await page.waitForTimeout(200);
      expect(await frame.evaluate(deck.current)).toBe(0);
      expect((await msgs(page)).some((m) => m.t === 'changed')).toBe(false);
    });

    test('a click on the slide is forwarded as next', async ({ page }) => {
      const frame = await openHarness(page, deck.slug);
      await clearMsgs(page);
      await frame.locator('body').click({ position: { x: 300, y: 200 } });
      await expect.poll(async () => (await msgs(page)).filter((m) => m.t === 'input').map((m) => m.action))
        .toEqual(['next']);
      expect(await frame.evaluate(deck.current)).toBe(0);
    });

    test('preview mode swallows input without forwarding', async ({ page }) => {
      const frame = await openHarness(page, deck.slug);
      await page.evaluate(() => window.send({ t: 'mode', mode: 'preview' }));
      await page.waitForTimeout(100);
      await clearMsgs(page);
      await pressInFrame(page, frame, 'ArrowRight');
      await frame.locator('body').click({ position: { x: 300, y: 200 } });
      await page.waitForTimeout(300);
      expect(await msgs(page)).toEqual([]);
      expect(await frame.evaluate(deck.current)).toBe(0);
    });
  });
}

test('legacy #next button produces input next without moving', async ({ page }) => {
  const frame = await openHarness(page, 'legacy-pres');
  await clearMsgs(page);
  await frame.locator('#next').click();
  await frame.locator('#prev').click();
  await expect.poll(async () => (await msgs(page)).filter((m) => m.t === 'input').map((m) => m.action))
    .toEqual(['next', 'prev']);
  expect(await frame.evaluate(() => window.PRES.actual())).toBe(0);
});

test('legacy: keys outside the table pass through (index overlay still opens)', async ({ page }) => {
  const frame = await openHarness(page, 'legacy-pres');
  await clearMsgs(page);
  await pressInFrame(page, frame, 'i');
  await expect(frame.locator('#index')).toBeVisible();
  expect((await msgs(page)).filter((m) => m.t === 'input')).toEqual([]);
});

test('legacy: interactive buttons inside a slide still work', async ({ page }) => {
  const frame = await openHarness(page, 'legacy-pres');
  await page.evaluate(() => window.send({ t: 'go', index: 10 }));
  await expect(frame.locator('#fin')).toBeVisible();
  await clearMsgs(page);
  await frame.locator('#local-btn').click();
  await expect(frame.locator('#local-btn')).toHaveText('clicked');
  expect((await msgs(page)).filter((m) => m.t === 'input')).toEqual([]);
});

test('legacy: a horizontal swipe is forwarded, not applied', async ({ page }) => {
  const frame = await openHarness(page, 'legacy-pres');
  await clearMsgs(page);
  await frame.evaluate(() => {
    const stage = document.getElementById('stage');
    const touch = (x) => new Touch({ identifier: 1, target: stage, clientX: x, clientY: 200 });
    stage.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch(400)], changedTouches: [touch(400)] }));
    stage.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [touch(250)] }));
  });
  await expect.poll(async () => (await msgs(page)).filter((m) => m.t === 'input').map((m) => m.action))
    .toEqual(['next']);
  expect(await frame.evaluate(() => window.PRES.actual())).toBe(0);
});

test('a page without a deck API reports no-deck-api', async ({ page }) => {
  await openHarness(page, 'noapi');
  expect((await msgs(page)).find((m) => m.t === 'error')).toEqual({ sd: 1, t: 'error', code: 'no-deck-api' });
});

test('the deck runs on an opaque origin: no cookies, no same-origin API', async ({ page, context }) => {
  await context.addCookies([{ name: 'sd_session', value: 'secret-value', url: srv.url }]);
  const frame = await openHarness(page, 'demo');
  const result = await frame.evaluate(async () => {
    let cookie;
    try { cookie = document.cookie; } catch (e) { cookie = `throws:${e.name}`; }
    let fetched;
    try {
      const r = await fetch('/api/session');
      fetched = `status:${r.status}`;
    } catch (e) { fetched = `fails:${e.name}`; }
    return { cookie, fetched, origin: self.origin };
  });
  expect(result.cookie === '' || result.cookie.startsWith('throws:')).toBe(true);
  expect(result.cookie).not.toContain('secret-value');
  expect(result.fetched).toMatch(/^fails:/);
  expect(result.origin).toBe('null');
});
