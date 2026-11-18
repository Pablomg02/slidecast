import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from './server.js';

// The shared pointer in the pages (T7 of 0010) on the demo deck, frozen with
// the pointer on. Both passwords set, so a loopback browser without a session
// is a plain participant; admin cookies give presenter rights, one device each.
let srv;
let adminCookie;
let secondCookie;
test.beforeAll(async () => {
  srv = await startServer({ passwords: { presenter: 'presenter-pass1', admin: 'admin-password1' } });
  adminCookie = await srv.login('admin', 'admin-password1');
  secondCookie = await srv.login('presenter', 'presenter-pass1');
});
test.afterAll(async () => srv?.close());

const ADMIN = () => ({ host: 'localhost', origin: 'http://localhost', cookie: `sc_session=${adminCookie}` });

let contexts = [];
test.afterEach(async () => {
  for (const c of contexts) await c.close();
  contexts = [];
});

async function newPage(browser, { cookie = null, ...opts } = {}) {
  const context = await browser.newContext(opts);
  contexts.push(context);
  if (cookie) await context.addCookies([{ name: 'sc_session', value: cookie, url: srv.url }]);
  return context.newPage();
}

const deckFrame = (page) => page.frames().find((f) => f.url().includes('/_deck/') && !f.url().includes('?static'));
const deckReady = (page) => expect.poll(() => deckFrame(page)?.evaluate(() => Boolean(window.SLIDECAST_DECK)).catch(() => false)).toBe(true);

// The presenter page, with every ptr frame it sends recorded in `frames`.
async function presenter(browser, cookie = adminCookie) {
  const page = await newPage(browser, { cookie });
  const frames = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    try {
      const m = JSON.parse(f.payload);
      if (m.t === 'ptr') frames.push(m);
    } catch { /* not ours */ }
  }));
  await page.goto(`${srv.url}/demo/present`);
  await expect(page.locator('#counter')).toHaveText(/ \/ 7$/);
  await expect(page.locator('.p-current .deck-virtual')).toHaveCount(1);
  return { page, frames };
}

async function participant(browser, viewport = { width: 1280, height: 720 }) {
  const page = await newPage(browser, { viewport });
  await page.goto(`${srv.url}/demo/view`);
  await page.click('#join-anonymous');
  await expect(page.locator('#who')).toContainText('Participant');
  await deckReady(page);
  return page;
}

const rect = (page, sel) => page.locator(sel).first().evaluate((n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

// Where a page shows its dot, as fractions of its .deck-layer.
async function dotAt(page, cls = '.ptr-dot') {
  if (await page.locator(cls).count() === 0) return null;
  const layer = await rect(page, '.deck-layer');
  const dot = await rect(page, cls);
  return [(dot.x + dot.w / 2 - layer.x) / layer.w, (dot.y + dot.h / 2 - layer.y) / layer.h];
}
const close = (a, b) => a && Math.abs(a[0] - b[0]) <= 0.015 && Math.abs(a[1] - b[1]) <= 0.015;

// Moves the mouse to a fraction of the presenter's current slide.
async function pointAt(page, fx, fy) {
  const r = await rect(page, '.p-current');
  await page.mouse.move(r.x + r.w * fx, r.y + r.h * fy, { steps: 2 });
}

const metaFile = () => join(srv.dataDir, 'demo', 'deck.json');
async function setDeck(fields, { index = 0 } = {}) {
  const meta = { ...JSON.parse(await readFile(metaFile(), 'utf8')), ...fields };
  for (const [k, v] of Object.entries(fields)) if (v === undefined) delete meta[k];
  await writeFile(metaFile(), JSON.stringify(meta));
  srv.app.slidecast.live.resetDeck('demo');
  for (const o of [false, true]) {
    await srv.app.inject({ method: 'PATCH', url: '/api/admin/rooms/demo', headers: ADMIN(), payload: { open: o } });
  }
  const s = srv.socket('demo', { cookie: adminCookie });
  await s.send({ t: 'meta', total: 7 });
  await s.send({ t: 'blank', on: false });
  await s.send({ t: 'goto', index });
  await s.send({ t: 'nav', mode: meta.viewerNav ?? 'back' });
  await s.state((m) => m.index === index && !m.blank && m.pointer === (meta.pointer === true && meta.frozen === true));
  s.close();
}

test.beforeEach(async () => {
  await setDeck({ frozen: true, pointer: true, viewerNav: 'back' }, { index: 1 });
});

test('the laser button shows only while the deck has the pointer on', async ({ browser }) => {
  await setDeck({ frozen: true, pointer: undefined }, { index: 1 });
  const { page } = await presenter(browser);
  await expect(page.locator('#laser')).toBeHidden();
  await page.keyboard.press('p');
  await expect(page.locator('.p-current')).not.toHaveClass(/p-laser-on/);
  const res = await srv.app.inject({ method: 'PATCH', url: '/api/admin/decks/demo', headers: ADMIN(), payload: { pointer: true } });
  expect(res.statusCode).toBe(200);
  await expect(page.locator('#laser')).toBeVisible();
  await expect(page.locator('#laser')).toHaveAttribute('aria-pressed', 'false');
});

test('with the laser off, moving the mouse shows nothing to the audience', async ({ browser }) => {
  const { page, frames } = await presenter(browser);
  const v = await participant(browser);
  await pointAt(page, 0.5, 0.5);
  await pointAt(page, 0.3, 0.6);
  await page.waitForTimeout(400);
  await expect(v.locator('.ptr-dot')).toHaveCount(0);
  expect(frames).toEqual([]);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`P and a move put the dot at the same place of the slide (${viewport.width}×${viewport.height})`, async ({ browser }) => {
    const { page } = await presenter(browser);
    const v = await participant(browser, viewport);
    const layer = await rect(v, '.deck-layer');
    const frame = await rect(v, '.deck-frame');
    for (const k of ['x', 'y', 'w', 'h']) expect(Math.abs(layer[k] - frame[k])).toBeLessThanOrEqual(1);
    await page.keyboard.press('p');
    await expect(page.locator('#laser')).toHaveAttribute('aria-pressed', 'true');
    await pointAt(page, 0.25, 0.75);
    await expect(v.locator('.ptr-dot.ptr-c0')).toHaveCount(1);
    await expect.poll(() => dotAt(v).then((d) => close(d, [0.25, 0.75]))).toBe(true);
    // The presenter sees its own dot where its mouse is.
    await expect.poll(() => dotAt(page).then((d) => close(d, [0.25, 0.75]))).toBe(true);
  });
}

test('a dot held still stays, and a participant who joins meanwhile sees it', async ({ browser }) => {
  const { page } = await presenter(browser);
  const v = await participant(browser);
  await page.keyboard.press('p');
  await pointAt(page, 0.6, 0.4);
  await expect.poll(() => dotAt(v).then((d) => close(d, [0.6, 0.4]))).toBe(true);
  const late = await participant(browser, { width: 390, height: 844 });
  const joined = Date.now();
  await expect(late.locator('.ptr-dot')).toHaveCount(1, { timeout: 2000 });
  expect(Date.now() - joined).toBeLessThan(2000);
  expect(close(await dotAt(late), [0.6, 0.4])).toBe(true);
  await v.waitForTimeout(5000);
  await expect(v.locator('.ptr-dot')).toHaveCount(1);
  expect(close(await dotAt(v), [0.6, 0.4])).toBe(true);
});

test('a second presenter shows its dot in the second colour', async ({ browser }) => {
  const first = await presenter(browser);
  const second = await presenter(browser, secondCookie);
  const v = await participant(browser);
  await first.page.keyboard.press('p');
  await second.page.keyboard.press('p');
  await pointAt(first.page, 0.2, 0.2);
  await expect(v.locator('.ptr-dot.ptr-c0')).toHaveCount(1);
  await pointAt(second.page, 0.8, 0.7);
  await expect(v.locator('.ptr-dot.ptr-c1')).toHaveCount(1);
  await expect.poll(() => dotAt(v, '.ptr-dot.ptr-c1').then((d) => close(d, [0.8, 0.7]))).toBe(true);
  await expect.poll(() => dotAt(first.page, '.ptr-dot.ptr-c1').then((d) => close(d, [0.8, 0.7]))).toBe(true);
  await expect(second.page.locator('#laser')).toHaveCSS('--laser', '#ffcc00');
});

test('leaving the slide, a new step and a blank screen hide the dot', async ({ browser }) => {
  const { page, frames } = await presenter(browser);
  const v = await participant(browser);
  await page.keyboard.press('p');
  await pointAt(page, 0.5, 0.5);
  await expect(v.locator('.ptr-dot')).toHaveCount(1);
  const r = await rect(page, '.p-current');
  await page.mouse.move(r.x + r.w / 2, r.y + r.h + 40); // out of the slide
  await expect(v.locator('.ptr-dot')).toHaveCount(0);
  await page.waitForTimeout(2000); // a keep-alive would have gone out by now
  const off = frames.findLastIndex((m) => m.off === true);
  expect(off).toBeGreaterThanOrEqual(0);
  expect(frames.slice(off + 1).filter((m) => 'x' in m)).toEqual([]);

  // The mouse stays on the slide: the step change itself hides the dot,
  // well before the 4 s safety timeout could.
  await pointAt(page, 0.5, 0.5);
  await expect(v.locator('.ptr-dot')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(v.locator('.ptr-dot')).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator('.p-current .ptr-dot')).toHaveCount(0, { timeout: 1500 });

  await pointAt(page, 0.4, 0.4);
  await expect(v.locator('.ptr-dot')).toHaveCount(1);
  await page.keyboard.press('b');
  await expect(v.locator('.ptr-dot')).toHaveCount(0, { timeout: 1500 });
  await pointAt(page, 0.45, 0.45);
  await page.waitForTimeout(400);
  await expect(v.locator('.ptr-dot')).toHaveCount(0);
});

test('a participant on a past step sees no dot', async ({ browser }) => {
  await setDeck({ frozen: true, pointer: true, viewerNav: 'back' }, { index: 2 });
  const { page } = await presenter(browser);
  const v = await participant(browser);
  await v.evaluate(() => document.activeElement?.blur());
  await v.keyboard.press('ArrowLeft');
  await expect.poll(() => deckFrame(v).evaluate(() => window.SLIDECAST_DECK.current())).toBe(1);
  const onLive = await participant(browser);
  await page.keyboard.press('p');
  await pointAt(page, 0.5, 0.5);
  await pointAt(page, 0.55, 0.5);
  await expect(onLive.locator('.ptr-dot')).toHaveCount(1); // the dot was sent
  await page.waitForTimeout(300);
  await expect(v.locator('.ptr-dot')).toHaveCount(0);
});

test('a participant who steps away from the live step, or whose deck moves itself, loses the dot', async ({ browser }) => {
  await setDeck({ frozen: true, pointer: true, viewerNav: 'free' }, { index: 2 });
  const { page } = await presenter(browser);
  const v = await participant(browser);
  await page.keyboard.press('p');
  await pointAt(page, 0.5, 0.5);
  await expect(v.locator('.ptr-dot')).toHaveCount(1);
  await v.evaluate(() => document.activeElement?.blur());
  await v.keyboard.press('ArrowLeft');
  await expect(v.locator('.ptr-dot')).toHaveCount(0, { timeout: 1500 });
  await v.keyboard.press('l'); // back to the live step: the keep-alive shows it again
  await expect(v.locator('.ptr-dot')).toHaveCount(1, { timeout: 3000 });
  await deckFrame(v).evaluate(() => window.SLIDECAST_DECK.go(4)); // the deck moves by itself
  await expect(v.locator('.ptr-dot')).toHaveCount(0, { timeout: 1500 });
});

test('a dot that gets no more messages goes away after about 4 s', async ({ browser }) => {
  const v = await participant(browser);
  const raw = srv.socket('demo', { cookie: adminCookie });
  await raw.send({ t: 'ptr', x: 5000, y: 5000 });
  await expect(v.locator('.ptr-dot')).toHaveCount(1);
  const shown = Date.now();
  await expect(v.locator('.ptr-dot')).toHaveCount(0, { timeout: 6000 });
  expect(Date.now() - shown).toBeGreaterThan(3000);
  raw.close();
});

test('P in a text field types; turning the pointer off live turns the laser off', async ({ browser }) => {
  const { page } = await presenter(browser);
  const v = await participant(browser);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'typing';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press('p');
  await expect(page.locator('#typing')).toHaveValue('p');
  await expect(page.locator('#laser')).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => document.getElementById('typing').remove());
  await page.keyboard.press('p');
  await expect(page.locator('#laser')).toHaveAttribute('aria-pressed', 'true');
  await pointAt(page, 0.5, 0.5);
  await expect(v.locator('.ptr-dot')).toHaveCount(1);
  const res = await srv.app.inject({ method: 'PATCH', url: '/api/admin/decks/demo', headers: ADMIN(), payload: { pointer: false } });
  expect(res.statusCode).toBe(200);
  await expect(page.locator('#laser')).toBeHidden();
  await expect(page.locator('#laser')).toHaveAttribute('aria-pressed', 'false');
  await expect(v.locator('.ptr-dot')).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator('.p-current')).not.toHaveClass(/p-laser-on/);
});

test('continuous movement sends at most one position every 66 ms', async ({ browser }) => {
  const page = await newPage(browser, { cookie: adminCookie });
  // Every ptr position the page sends, stamped by the page itself.
  await page.addInitScript(() => {
    window.__sent = [];
    const real = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const m = JSON.parse(data);
        if (m.t === 'ptr' && 'x' in m) window.__sent.push(performance.now());
      } catch { /* not JSON */ }
      return real.call(this, data);
    };
  });
  await page.goto(`${srv.url}/demo/present`);
  await expect(page.locator('.p-current .deck-virtual')).toHaveCount(1);
  await page.keyboard.press('p');
  const r = await rect(page, '.p-current');
  for (let i = 0; i < 120; i++) await page.mouse.move(r.x + 10 + i * 3, r.y + r.h / 2);
  const sent = await page.evaluate(() => window.__sent);
  expect(sent.length).toBeGreaterThan(3);
  const gaps = sent.slice(1).map((t, i) => t - sent[i]);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60);
});
