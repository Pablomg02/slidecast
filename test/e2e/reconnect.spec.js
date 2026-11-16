import { test, expect } from '@playwright/test';
import { createServer } from 'node:net';
import { startServer } from './server.js';

// Phones freeze background pages: a socket may hang in "connecting" for good,
// or look open while dead. connectLive must get out of both by itself.

// The hole is on another port: the page's connect-src 'self' would block it.
test.use({ bypassCSP: true });

let srv;
let presenter;
let presenterCookie;
let hole; // accepts TCP connections and never answers: a socket stays CONNECTING
let holeUrl;
test.beforeAll(async () => {
  srv = await startServer({ passwords: { presenter: 'presenter-pass', admin: 'admin-password' } });
  presenterCookie = await srv.login('presenter', 'presenter-pass');
  const held = [];
  hole = createServer((s) => held.push(s));
  hole.on('close', () => held.forEach((s) => s.destroy()));
  await new Promise((r) => hole.listen(0, '127.0.0.1', r));
  holeUrl = `ws://127.0.0.1:${hole.address().port}/`;
  hole.unref();
});
test.afterAll(async () => {
  presenter?.close();
  hole?.close();
  await srv?.close();
});

test.beforeEach(async () => {
  presenter?.close();
  presenter = srv.socket('demo', { cookie: presenterCookie });
  await presenter.send({ t: 'meta', total: 7 });
  await presenter.send({ t: 'goto', index: 0 });
  await presenter.send({ t: 'nav', mode: 'follow' });
  await presenter.state((s) => s.index === 0 && s.viewerNav === 'follow');
});

const deckFrame = (page) => page.frames().find((f) => f.url().includes('/_deck/'));
const current = (page) => deckFrame(page).evaluate(() => window.SLIDECAST_DECK.current());
const badge = (page) => page.locator('.badge-warn', { hasText: 'Reconnecting' });

// The page's sockets are kept in window.__sockets; with window.__hole set,
// new ones go to the hole instead of the server, and a socket with __deaf set
// gets no more messages (open but dead, as after a network change). Sent
// pings are counted in window.__pings. document.visibilityState follows
// window.__visibility, so the test can hide and show the page.
async function openViewer(page) {
  await page.addInitScript((url) => {
    localStorage.setItem('slidecast.name', '{"name":null}');
    const Real = window.WebSocket;
    window.__sockets = [];
    window.__hole = false;
    window.__pings = 0;
    window.WebSocket = class extends Real {
      constructor(u, p) {
        super(window.__hole ? url : u, p);
        window.__sockets.push(this);
      }
      set onmessage(fn) { super.onmessage = (e) => { if (!this.__deaf) fn(e); }; }
      get onmessage() { return super.onmessage; }
      send(data) {
        if (JSON.parse(data).t === 'ping') window.__pings++;
        super.send(data);
      }
    };
    window.__visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__visibility });
  }, holeUrl);
  await page.goto(`${srv.url}/demo/view`);
  await expect.poll(() => deckFrame(page)?.evaluate(() => Boolean(window.SLIDECAST_DECK)).catch(() => false)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__sockets.at(-1)?.readyState)).toBe(1);
}

// Drops the live socket while new attempts hang, as a frozen phone would.
async function hangReconnects(page) {
  await page.evaluate(() => {
    window.__hole = true;
    window.__sockets.at(-1).close();
  });
  await expect(badge(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__sockets.at(-1).url)).toBe(holeUrl);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__sockets.at(-1).readyState)).toBe(0); // still connecting
}

const setVisibility = (page, v) => page.evaluate((state) => {
  window.__visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}, v);

async function followsPresenter(page, index) {
  await presenter.send({ t: 'goto', index });
  await expect.poll(() => current(page)).toBe(index);
}

test('an attempt that never connects is dropped and retried', async ({ page }) => {
  test.slow();
  await openViewer(page);
  await hangReconnects(page);
  await page.evaluate(() => { window.__hole = false; });
  // The hanging attempt is given up after 10 s, then the next one gets through.
  await expect(badge(page)).toBeHidden({ timeout: 15_000 });
  await followsPresenter(page, 2);
});

test('coming back to the page reconnects at once', async ({ page }) => {
  await openViewer(page);
  await hangReconnects(page);
  await setVisibility(page, 'hidden');
  await page.evaluate(() => { window.__hole = false; });
  await setVisibility(page, 'visible');
  await expect(badge(page)).toBeHidden({ timeout: 2000 });
  await followsPresenter(page, 3);
});

test('coming back pings an open socket: a live one is kept, a dead one replaced', async ({ page }) => {
  test.slow();
  await openViewer(page);
  const count = () => page.evaluate(() => window.__sockets.length);
  const pings = () => page.evaluate(() => window.__pings);
  const before = await count();

  // Several events for one return send one ping; the answer keeps the socket.
  await setVisibility(page, 'hidden');
  await page.evaluate(() => {
    window.__visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  expect(await pings()).toBe(1);
  await page.waitForTimeout(6000); // past the 5 s wait for a pong
  expect(await count()).toBe(before);
  await expect(badge(page)).toBeHidden();
  await followsPresenter(page, 2);

  // The first load fires pageshow too: it must not replace the socket.
  expect(await count()).toBe(before);

  // Open but dead: no pong, so a fresh socket within 5 s.
  await page.evaluate(() => { window.__sockets.at(-1).__deaf = true; });
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await expect.poll(count, { timeout: 7000 }).toBe(before + 1);
  await expect.poll(() => page.evaluate(() => window.__sockets.at(-2).readyState)).toBe(3);
  await expect.poll(() => page.evaluate(() => window.__sockets.at(-1).readyState)).toBe(1);
  await expect(badge(page)).toBeHidden();
  await followsPresenter(page, 4);
});

test('coming back while the first attempt still connects keeps it', async ({ page }) => {
  await openViewer(page);
  await hangReconnects(page);
  await page.evaluate(() => { window.__hole = false; });
  // Visible again, then restored from the cache: one fresh attempt, not two.
  const before = await page.evaluate(() => window.__sockets.length);
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(badge(page)).toBeHidden({ timeout: 2000 });
  expect(await page.evaluate(() => window.__sockets.length)).toBe(before + 1);
  await followsPresenter(page, 5);
});
