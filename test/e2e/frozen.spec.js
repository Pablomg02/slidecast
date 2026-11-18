import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from './server.js';

// Frozen decks (0010): every screen lays the deck out at its virtual size
// (1920×1080 for 16:9) and scales it to fit. Both passwords set, so a loopback
// browser without a session is a plain participant; the admin's cookie gives
// presenter and admin rights.

// A fixed-stage deck with the native API and an interactive counter.
const WIDGET_DECK = `<!doctype html><html><head><meta charset="utf-8"><title>Widget</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
#stage{position:absolute;left:0;top:0;width:1600px;height:900px;transform-origin:0 0;background:#fff}
#widget{position:absolute;left:600px;top:350px;width:400px;height:200px}
#plus{width:100%;height:100%;font-size:60px}</style></head><body>
<div id="stage"><p id="where">0</p><div id="widget" data-interactive><button id="plus">0</button></div></div>
<script>
(function () {
  var stage = document.getElementById('stage');
  function fit() {
    var s = Math.min(innerWidth / 1600, innerHeight / 900);
    stage.style.transform = 'translate(' + (innerWidth - 1600 * s) / 2 + 'px,' + (innerHeight - 900 * s) / 2 + 'px) scale(' + s + ')';
  }
  addEventListener('resize', fit); fit();
  var n = 0;
  document.getElementById('plus').addEventListener('click', function () { this.textContent = String(++n); });
  var current = 0;
  var steps = [{ slide: 'a', step: 0 }, { slide: 'b', step: 0 }, { slide: 'c', step: 0 }];
  function go(i) {
    current = Math.max(0, Math.min(steps.length - 1, Math.floor(i) || 0));
    document.getElementById('where').textContent = String(current);
    dispatchEvent(new CustomEvent('slidecast:change', { detail: { index: current } }));
  }
  window.SLIDECAST_DECK = { version: 1, steps: steps, go: go, current: function () { return current; } };
  go(0);
})();
</script></body></html>`;

let srv;
let adminCookie;
test.beforeAll(async () => {
  srv = await startServer({
    passwords: { presenter: 'presenter-pass1', admin: 'admin-password1' },
    extraDecks: { widget: WIDGET_DECK },
  });
  adminCookie = await srv.login('admin', 'admin-password1');
});
test.afterAll(async () => srv?.close());

const ADMIN = () => ({ host: 'localhost', origin: 'http://localhost', cookie: `sc_session=${adminCookie}` });

let contexts = [];
test.afterEach(async () => {
  for (const c of contexts) await c.close();
  contexts = [];
});

async function open(browser, path, { cookie = null, ...opts } = {}) {
  const context = await browser.newContext(opts);
  contexts.push(context);
  if (cookie) await context.addCookies([{ name: 'sc_session', value: cookie, url: srv.url }]);
  const page = await context.newPage();
  await page.goto(`${srv.url}${path}`);
  return page;
}

const deckFrame = (page) => page.frames().find((f) => f.url().includes('/_deck/') && !f.url().includes('?static'));
const deckReady = (page) => expect.poll(() => deckFrame(page)?.evaluate(() => Boolean(window.SLIDECAST_DECK)).catch(() => false)).toBe(true);
const deckIndex = (page) => deckFrame(page).evaluate(() => window.SLIDECAST_DECK.current());

async function participant(browser, slug = 'demo', opts = {}) {
  const page = await open(browser, `/${slug}/view`, opts);
  await page.click('#join-anonymous');
  await expect(page.locator('#who')).toContainText('Participant');
  await deckReady(page);
  return page;
}

const rect = (page, sel) => page.locator(sel).first().evaluate((n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
function near(a, b, tol = 1) {
  for (const k of ['x', 'y', 'w', 'h']) expect(Math.abs(a[k] - b[k]), `${k}: ${a[k]} vs ${b[k]}`).toBeLessThanOrEqual(tol);
}

const metaFile = (slug) => join(srv.dataDir, slug, 'deck.json');
async function readMeta(slug) {
  try {
    return JSON.parse(await readFile(metaFile(slug), 'utf8'));
  } catch {
    return { slidecast: 1, slides: {} };
  }
}

// Writes deck.json with the given fields and starts a fresh room on step `index`.
async function setDeck(slug, fields, { index = 0, total = 7 } = {}) {
  const meta = { ...(await readMeta(slug)), ...fields };
  for (const [k, v] of Object.entries(fields)) if (v === undefined) delete meta[k];
  await writeFile(metaFile(slug), JSON.stringify(meta));
  srv.app.slidecast.live.resetDeck(slug);
  for (const o of [false, true]) {
    await srv.app.inject({ method: 'PATCH', url: `/api/admin/rooms/${slug}`, headers: ADMIN(), payload: { open: o } });
  }
  const s = srv.socket(slug, { cookie: adminCookie });
  await s.send({ t: 'meta', total });
  await s.send({ t: 'blank', on: false });
  await s.send({ t: 'goto', index });
  await s.send({ t: 'nav', mode: meta.viewerNav ?? 'back' });
  await s.state((m) => m.index === index && !m.blank && m.viewerNav === (meta.viewerNav ?? 'back'));
  s.close();
}

test('viewer on a phone: the frozen deck is laid out at 1920×1080 and shown scaled, centred', async ({ browser }) => {
  await setDeck('demo', { frozen: true, viewerNav: 'back' });
  const v = await participant(browser, 'demo', { viewport: { width: 390, height: 844 } });
  await expect(v.locator('.viewer-stage .deck-virtual')).toHaveCount(1);
  expect(await deckFrame(v).evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
  const shown = await rect(v, '.deck-frame');
  expect(Math.abs(shown.w - 390)).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.h - 219.375)).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.y - (844 - shown.h) / 2)).toBeLessThanOrEqual(1);
  near(await rect(v, '.deck-layer'), shown);
});

test('opening a poll shrinks the stage and the frozen deck refits inside it', async ({ browser }) => {
  await setDeck('demo', { frozen: true, viewerNav: 'back' }, { index: 4 });
  const p = await open(browser, '/demo/present', { cookie: adminCookie });
  await expect(p.locator('#counter')).toHaveText('5 / 7');
  const v = await participant(browser, 'demo', { viewport: { width: 1280, height: 720 } });
  const before = await rect(v, '.deck-frame');
  await p.click('#poll-launch');
  await expect(v.locator('#poll-panel')).toBeVisible();
  await expect(v.locator('body')).toHaveClass(/poll-open/);
  await expect.poll(async () => (await rect(v, '.deck-frame')).w).toBeLessThan(before.w - 1);
  const stage = await rect(v, '.viewer-stage');
  const shown = await rect(v, '.deck-frame');
  expect(shown.x).toBeGreaterThanOrEqual(stage.x - 1);
  expect(shown.y).toBeGreaterThanOrEqual(stage.y - 1);
  expect(shown.x + shown.w).toBeLessThanOrEqual(stage.x + stage.w + 1);
  expect(shown.y + shown.h).toBeLessThanOrEqual(stage.y + stage.h + 1);
  // Contain-fit: one side touches the stage.
  expect(Math.min(Math.abs(shown.w - stage.w), Math.abs(shown.h - stage.h))).toBeLessThanOrEqual(1);
  near(await rect(v, '.deck-layer'), shown);
});

test('presenter: the frozen current slide fills its box; the end card shows on the last step', async ({ browser }) => {
  await setDeck('demo', { frozen: true, viewerNav: 'back' }, { index: 5 });
  const p = await open(browser, '/demo/present', { cookie: adminCookie, viewport: { width: 1400, height: 900 } });
  await expect(p.locator('#counter')).toHaveText('6 / 7');
  await expect(p.locator('.p-current .deck-virtual')).toHaveCount(1);
  await expect.poll(async () => {
    const a = await rect(p, '.p-current .deck-frame');
    const b = await rect(p, '.p-current');
    return Math.max(...['x', 'y', 'w', 'h'].map((k) => Math.abs(a[k] - b[k])));
  }).toBeLessThanOrEqual(1);
  expect(await deckFrame(p).evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
  await expect(p.locator('.p-end')).toBeHidden();
  await p.click('#next');
  await expect(p.locator('#counter')).toHaveText('7 / 7');
  await expect(p.locator('.p-end')).toBeVisible();
  await expect(p.locator('.p-next .deck-virtual')).toBeHidden();
});

test('a click on a button inside data-interactive reaches the frozen deck', async ({ browser }) => {
  await setDeck('widget', { frozen: true, viewerNav: 'back' }, { total: 3 });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    const v = await participant(browser, 'widget', { viewport });
    const frame = deckFrame(v);
    await frame.locator('#plus').click();
    await expect(frame.locator('#plus')).toHaveText('1');
    // A real mouse click at the button's centre on screen, computed by hand.
    const shown = await rect(v, '.deck-frame');
    const s = shown.w / 1920;
    const sx = Math.min(1920 / 1600, 1080 / 900); // the deck's own fit inside 1920×1080
    await v.mouse.click(shown.x + (800 * sx) * s, shown.y + (450 * sx) * s);
    await expect(frame.locator('#plus')).toHaveText('2');
    expect(await deckIndex(v)).toBe(0);
  }
});

test('a click on the black bars moves to the next step when the viewer may navigate', async ({ browser }) => {
  await setDeck('widget', { frozen: true, viewerNav: 'free' }, { total: 3 });
  const v = await participant(browser, 'widget', { viewport: { width: 390, height: 844 } });
  await expect(v.locator('body')).toHaveAttribute('data-nav', 'free');
  const shown = await rect(v, '.deck-frame');
  await v.mouse.move(195, shown.y / 2);
  await v.mouse.click(195, shown.y / 2); // above the slide
  await expect.poll(() => deckIndex(v)).toBe(1);
});

// ---- open screens follow layout changes (T4) --------------------------------

const patchDeck = (slug, payload) => srv.app.inject({ method: 'PATCH', url: `/api/admin/decks/${slug}`, headers: ADMIN(), payload });
// A mark that a reload wipes.
const mark = (page) => page.evaluate(() => { window.__notReloaded = true; });
const reloaded = (page) => page.waitForFunction(() => window.__notReloaded !== true, null, { timeout: 10_000 });

test('turning frozen on reloads every open screen on the live step; names and the talk timer stay', async ({ browser }) => {
  await setDeck('demo', { frozen: undefined, viewerNav: 'back' }, { index: 2 });
  const p = await open(browser, '/demo/present', { cookie: adminCookie });
  await expect(p.locator('#counter')).toHaveText('3 / 7');
  await expect(p.locator('.deck-virtual')).toHaveCount(0);
  await p.click('#timer-toggle');
  const v = await open(browser, '/demo/view');
  await v.fill('#join-name', 'Ana');
  await v.click('#join-enter');
  await expect(v.locator('#who')).toContainText('Ana');
  await deckReady(v);
  await expect(v.locator('.deck-virtual')).toHaveCount(0);
  await p.waitForTimeout(2100);
  await expect(p.locator('#timer')).not.toHaveText('00:00');
  await mark(p);
  await mark(v);

  expect((await patchDeck('demo', { frozen: true })).statusCode).toBe(200);
  await reloaded(p);
  await reloaded(v);
  await expect(p.locator('#counter')).toHaveText('3 / 7');
  await expect(p.locator('.p-current .deck-virtual')).toHaveCount(1);
  // The timer goes on from where it was (2.1 s or more), it does not start again.
  const seconds = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
  expect(seconds(await p.locator('#timer').textContent())).toBeGreaterThanOrEqual(2);
  await expect(p.locator('#timer-toggle')).toHaveText('Pause');
  await deckReady(v);
  await expect(v.locator('.viewer-stage .deck-virtual')).toHaveCount(1);
  await expect(v.locator('#who')).toContainText('Ana');
  await expect.poll(() => deckIndex(v)).toBe(2);
  await expect.poll(() => deckIndex(p)).toBe(2);
});

// A socket marked __deaf delivers neither messages nor its close to the page,
// like the socket of a phone asleep while the deck changed.
async function deafSockets(context) {
  await context.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Real {
      constructor(u, p) {
        super(u, p);
        window.__sockets.push(this);
      }
      set onmessage(h) { super.onmessage = (e) => { if (!this.__deaf) h(e); }; }
      get onmessage() { return super.onmessage; }
      set onclose(h) { super.onclose = h && ((e) => { if (!this.__deaf) h(e); }); }
      get onclose() { return super.onclose; }
    };
  });
}

test('a screen asleep when frozen was turned on reloads once it is back', async ({ browser }) => {
  await setDeck('demo', { frozen: undefined, viewerNav: 'back' });
  const context = await browser.newContext();
  contexts.push(context);
  await deafSockets(context);
  const v = await context.newPage();
  await v.goto(`${srv.url}/demo/view`);
  await v.click('#join-anonymous');
  await deckReady(v);
  await expect(v.locator('.deck-virtual')).toHaveCount(0);
  await mark(v);
  await v.evaluate(() => { window.__sockets.at(-1).__deaf = true; });
  expect((await patchDeck('demo', { frozen: true })).statusCode).toBe(200);
  await expect.poll(() => v.evaluate(() => window.__sockets.at(-1).readyState)).toBe(3);
  await v.waitForTimeout(300);
  expect(await v.evaluate(() => window.__notReloaded)).toBe(true); // the 4000 never reached it
  await v.evaluate(() => window.dispatchEvent(new Event('online'))); // it wakes up and reconnects
  await reloaded(v);
  await deckReady(v);
  await expect(v.locator('.viewer-stage .deck-virtual')).toHaveCount(1);
});

test('a layout the API and the live state disagree on never makes a page reload in a loop', async ({ browser }) => {
  await setDeck('demo', { frozen: true, viewerNav: 'back' });
  const live = srv.app.slidecast.live;
  const real = live.layoutOf;
  live.layoutOf = () => null; // the page loads unfrozen, the snapshots say frozen
  try {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    let loads = 0;
    page.on('load', () => { loads += 1; });
    const warnings = [];
    page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
    await page.goto(`${srv.url}/demo/view`);
    await expect.poll(() => warnings.some((w) => w.includes('not reloading again')), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(1500);
    expect(loads).toBe(2); // the first load and one reload, then it stops
  } finally {
    live.layoutOf = real;
  }
});

test('opening the presenter page anew starts the talk timer from zero', async ({ browser }) => {
  await setDeck('demo', { frozen: undefined, viewerNav: 'back' });
  const p = await open(browser, '/demo/present', { cookie: adminCookie });
  await p.click('#timer-toggle');
  await p.waitForTimeout(1200);
  await expect(p.locator('#timer')).not.toHaveText('00:00');
  await p.goto(`${srv.url}/admin`);
  await p.goto(`${srv.url}/demo/present`);
  await expect(p.locator('#counter')).toHaveText(/ \/ 7$/);
  await expect(p.locator('#timer')).toHaveText('00:00');
  await expect(p.locator('#timer-toggle')).toHaveText('Start');
});

test('without sessionStorage, a layout the API and the live state disagree on reloads nothing', async ({ browser }) => {
  await setDeck('demo', { frozen: true, viewerNav: 'back' });
  const live = srv.app.slidecast.live;
  const real = live.layoutOf;
  live.layoutOf = () => null;
  try {
    const context = await browser.newContext();
    contexts.push(context);
    await context.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } });
    });
    const page = await context.newPage();
    let loads = 0;
    page.on('load', () => { loads += 1; });
    const warnings = [];
    page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
    await page.goto(`${srv.url}/demo/view`);
    await expect.poll(() => warnings.some((w) => w.includes('not reloading again')), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(1500);
    expect(loads).toBe(1);
  } finally {
    live.layoutOf = real;
  }
});

test('the thumbnail of a frozen deck is drawn at its virtual size', async ({ browser }) => {
  await setDeck('demo', { frozen: true, aspect: '4:3', viewerNav: 'back' });
  try {
    const page = await open(browser, '/demo', { cookie: adminCookie });
    const box = page.locator('.thumb .deck-virtual');
    await expect(box).toHaveCount(1);
    expect(await box.evaluate((n) => [n.style.width, n.style.height])).toEqual(['1920px', '1440px']);
    const thumb = await rect(page, '.thumb');
    const shown = await rect(page, '.thumb .deck-frame');
    expect(Math.abs(shown.w - thumb.w)).toBeLessThanOrEqual(1);
  } finally {
    await setDeck('demo', { frozen: undefined, aspect: undefined, viewerNav: 'back' });
  }
});
