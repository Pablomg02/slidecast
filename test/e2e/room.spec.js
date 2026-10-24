import { test, expect } from '@playwright/test';
import { startServer } from './server.js';

let srv;
let adminCookie;
test.beforeAll(async () => {
  // Both passwords set, so this loopback browser is a plain viewer (not local
  // direct with presenter rights) unless it carries a session.
  srv = await startServer({ passwords: { presenter: 'presenter-pass1', admin: 'admin-password1' } });
  adminCookie = await srv.login('admin', 'admin-password1');
});
test.afterAll(async () => srv?.close());

// Through the admin API, as the panel does (it also updates live rooms).
function patchRoom(slug, payload) {
  return srv.app.inject({
    method: 'PATCH', url: `/api/admin/rooms/${slug}`,
    headers: { host: 'localhost', origin: 'http://localhost', cookie: `sc_session=${adminCookie}` },
    payload,
  });
}

// A fresh room for every test: closing it forgets everyone.
test.beforeEach(async () => {
  await patchRoom('demo', { open: false });
  await patchRoom('demo', { open: true });
});

async function presenterPage(browser) {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'sc_session', value: adminCookie, url: srv.url }]);
  const page = await context.newPage();
  await page.goto(`${srv.url}/demo/present`);
  return { page, context };
}

async function viewerPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${srv.url}/demo/view`);
  return { page, context };
}

test('a viewer gives a name that only presenters see, or joins anonymously', async ({ browser }) => {
  const { page: p, context: pc } = await presenterPage(browser);
  const { page: v, context: vc } = await viewerPage(browser);
  await expect(v.locator('.join-dialog')).toBeVisible();
  await v.fill('#join-name', 'Ana');
  await v.click('#join-enter');
  await expect(v.locator('#who')).toHaveText('You: Ana');
  const { page: w, context: wc } = await viewerPage(browser);
  await w.click('#join-anonymous');
  await expect(w.locator('#who')).toHaveText('You: Participant 002');

  await p.click('#tab-people');
  await expect(p.locator('#people-list')).toContainText('Ana');
  await expect(p.locator('#people-list')).toContainText('#001');
  await expect(p.locator('#people-list')).toContainText('Participant 002');
  await expect(p.locator('#viewers')).toHaveText('2 viewers');
  // The name is remembered: a reload asks nothing and keeps the number.
  await v.reload();
  await expect(v.locator('#who')).toHaveText('You: Ana');
  await expect(v.locator('.join-dialog')).toBeHidden();
  await Promise.all([pc.close(), vc.close(), wc.close()]);
});

test('raise a hand with a note; the presenter queues, attends and resolves it', async ({ browser }) => {
  const { page: p, context: pc } = await presenterPage(browser);
  const { page: v, context: vc } = await viewerPage(browser);
  await v.fill('#join-name', 'Luis');
  await v.click('#join-enter');
  await v.click('#hand');
  await v.fill('#hand-note', 'What about drag?');
  await v.click('#hand-raise');
  await expect(v.locator('#hand-status')).toHaveText('Hand raised');

  await expect(p.locator('#tab-hands .p-tab-count')).toHaveText('1');
  await expect(p.locator('#tab-hands')).toHaveClass(/p-tab-new/);
  await p.click('#tab-hands');
  await expect(p.locator('#tab-hands')).not.toHaveClass(/p-tab-new/);
  const hand = p.locator('#hand-list .hand');
  await expect(hand).toContainText('Luis');
  await expect(hand).toContainText('What about drag?');
  await hand.getByRole('button', { name: 'Queue' }).click();
  await expect(v.locator('#hand-status')).toHaveText('In the queue (#1)');
  await hand.getByRole('button', { name: 'Attend' }).click();
  await expect(v.locator('#hand-status')).toHaveText('The presenter is attending to you');
  await expect(v.locator('.toast')).toHaveText('The presenter is attending to you');
  await expect(hand).toHaveClass(/hand-attending/);
  await hand.getByRole('button', { name: 'Resolve' }).click();
  await expect(v.locator('.toast')).toHaveText('The presenter closed your question');
  await expect(v.locator('#hand')).toHaveText('Raise hand');
  await expect(p.locator('#hand-list')).toHaveText('No raised hands.');
  await Promise.all([pc.close(), vc.close()]);
});

test('a removed viewer stays out after a reload', async ({ browser }) => {
  const { page: p, context: pc } = await presenterPage(browser);
  const { page: v, context: vc } = await viewerPage(browser);
  await v.click('#join-anonymous');
  await expect(v.locator('#who')).toHaveText('You: Participant 001');
  await p.click('#tab-people');
  const kick = p.locator('#people-list .person button');
  await kick.click();
  await expect(kick).toHaveText('Remove?');
  await kick.click();
  await expect(v.locator('.room-notice')).toContainText('You were removed from the room');
  await v.reload();
  await expect(v.locator('.room-notice')).toContainText('You were removed from the room');
  await expect(p.locator('#people-list')).toHaveText('Nobody has joined yet.');
  await Promise.all([pc.close(), vc.close()]);
});

test('a closed room keeps viewers waiting; the admin opens it from the presenter view', async ({ browser }) => {
  const { page: p, context: pc } = await presenterPage(browser);
  const closeBtn = p.locator('#room-toggle');
  await expect(closeBtn).toHaveText('Close room');
  await closeBtn.click();
  await expect(closeBtn).toHaveText('Close? Everyone leaves');
  await closeBtn.click();
  await expect(p.locator('#room-closed')).toBeVisible();
  await expect(closeBtn).toHaveText('Open room');

  const { page: v, context: vc } = await viewerPage(browser);
  await expect(v.locator('.room-notice')).toContainText('This room is closed');
  await expect(v.locator('iframe')).toHaveCount(0);
  await closeBtn.click();
  // The waiting viewer enters by itself, without a reload by hand.
  await expect(v.locator('.join-dialog')).toBeVisible();
  await v.click('#join-anonymous');
  await expect(v.locator('.room-notice')).toBeHidden();
  await expect(v.locator('iframe.deck-frame')).toBeVisible();
  await expect(p.locator('#room-closed')).toBeHidden();
  await Promise.all([pc.close(), vc.close()]);
});

test('"/" follows the open room', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await patchRoom('demo', { only: true });
  await page.goto(`${srv.url}/`);
  await expect(page).toHaveURL(`${srv.url}/demo`);
  await patchRoom('legacy-pres', { only: true });
  await page.goto(`${srv.url}/`);
  await expect(page).toHaveURL(`${srv.url}/legacy-pres`);
  await patchRoom('demo', { open: true });
  await page.goto(`${srv.url}/`);
  await expect(page.locator('.deck-card')).toHaveCount(2); // several open: the list
  await context.close();
});

test('a device over the presenter limit is offered to watch; a projector stops controlling', async ({ browser }) => {
  await patchRoom('demo', { maxPresenters: 1 });
  try {
    const sessions = [await srv.login('presenter', 'presenter-pass1'), await srv.login('presenter', 'presenter-pass1')];
    const contexts = [];
    const pageFor = async (cookie, path) => {
      const context = await browser.newContext();
      contexts.push(context);
      await context.addCookies([{ name: 'sc_session', value: cookie, url: srv.url }]);
      const page = await context.newPage();
      await page.goto(`${srv.url}${path}`);
      return page;
    };
    const first = await pageFor(sessions[0], '/demo/present');
    await expect(first.locator('#viewers')).toBeVisible();
    const second = await pageFor(sessions[1], '/demo/present');
    await expect(second.locator('.p-full')).toContainText('This room already has all its presenters');
    await second.getByRole('link', { name: 'Watch as a viewer' }).click();
    await expect(second).toHaveURL(/\/demo\/view\?control=off$/);
    await expect(second.locator('iframe.deck-frame')).toBeVisible();
    // A projector window of that device would control: it falls back to a display.
    const projector = await pageFor(sessions[1], '/demo/view');
    await expect(projector).toHaveURL(/control=off/);
    await expect(projector.locator('.control-toggle')).toHaveText('Control');
    await Promise.all(contexts.map((c) => c.close()));
  } finally {
    await patchRoom('demo', { maxPresenters: 20 });
  }
});

test('a viewer that waited in a closed room and lost its connection still gets the deck', async ({ browser }) => {
  await patchRoom('demo', { open: false });
  const context = await browser.newContext();
  const v = await context.newPage();
  // Every live connection goes through the test, so it can cut one.
  let cut = null;
  await v.routeWebSocket(/\/ws\//, (ws) => {
    const server = ws.connectToServer();
    cut = () => { ws.close(); server.close(); };
  });
  await v.goto(`${srv.url}/demo/view`);
  await expect(v.locator('.room-notice')).toContainText('This room is closed');
  await expect.poll(() => Boolean(cut)).toBe(true);
  // The room opens while this viewer's connection is down: it never hears "reload".
  cut();
  await srv.app.slidecast.rooms.update('demo', { open: true });
  await expect(v.locator('iframe.deck-frame')).toBeVisible({ timeout: 15_000 });
  await expect(v.locator('.join-dialog')).toBeVisible();
  await context.close();
});
