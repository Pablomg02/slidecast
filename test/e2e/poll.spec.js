import { test, expect } from '@playwright/test';
import { startServer } from './server.js';

// Polls (0006). The demo deck has a poll on its "roles" slide (step 5 of 7).
let srv;
let adminCookie;
test.beforeAll(async () => {
  // Both passwords set, so a loopback browser without a session is a plain
  // participant (not local direct with presenter rights).
  srv = await startServer({ passwords: { presenter: 'presenter-pass1', admin: 'admin-password1' } });
  adminCookie = await srv.login('admin', 'admin-password1');
});
test.afterAll(async () => srv?.close());

function patchRoom(payload) {
  return srv.app.inject({
    method: 'PATCH', url: '/api/admin/rooms/demo',
    headers: { host: 'localhost', origin: 'http://localhost', cookie: `sc_session=${adminCookie}` },
    payload,
  });
}

// A fresh room for every test (closing it forgets every poll), at the roles slide.
test.beforeEach(async () => {
  await patchRoom({ open: false });
  await patchRoom({ open: true });
  const s = srv.socket('demo', { cookie: adminCookie });
  await s.send({ t: 'meta', total: 7 });
  await s.send({ t: 'blank', on: false });
  await s.send({ t: 'goto', index: 4 });
  await s.state((m) => m.index === 4 && !m.blank);
  s.close();
});

async function open(browser, path, { cookie = null, ...opts } = {}) {
  const context = await browser.newContext(opts);
  if (cookie) await context.addCookies([{ name: 'sc_session', value: cookie, url: srv.url }]);
  const page = await context.newPage();
  await page.goto(`${srv.url}${path}`);
  return { page, context };
}

async function presenter(browser, opts) {
  const p = await open(browser, '/demo/present', { cookie: adminCookie, ...opts });
  await expect(p.page.locator('#counter')).toHaveText('5 / 7');
  return p;
}

async function participant(browser, opts) {
  const v = await open(browser, '/demo/view', opts);
  await v.page.click('#join-anonymous');
  await expect(v.page.locator('#who')).toContainText('Participant');
  return v;
}

const card = (page) => page.locator('.p-poll-shown');
const result = (page, i) => page.locator('.poll-result').nth(i).locator('.poll-count');

test('the presenter launches the slide\'s poll; participants answer; the presenter and the projector see the counts', async ({ browser }) => {
  const { page: p, context: pc } = await presenter(browser);
  const strip = p.locator('#poll-strip');
  await expect(strip).toContainText('This slide has a poll');
  await expect(p.locator('#tab-poll')).toBeVisible();
  const { page: v, context: vc } = await participant(browser);
  const { page: w, context: wc } = await participant(browser);
  const { page: proj, context: projc } = await open(browser, '/demo/view', { cookie: adminCookie });
  await expect(v.locator('#poll-panel')).toBeHidden();

  await p.click('#poll-launch');
  await expect(p.locator('#tab-poll')).toHaveAttribute('aria-selected', 'true');
  await expect(card(p)).toContainText('On screens');
  await expect(card(p)).toContainText('Which role will you try first?');

  // The participant's slide makes room for the poll.
  const panel = v.locator('#poll-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.poll-question')).toHaveText('Which role will you try first?');
  await expect(v.locator('body')).toHaveClass(/poll-open/);
  const stage = await v.locator('.viewer-stage').boundingBox();
  const box = await panel.boundingBox();
  expect(stage.x + stage.width).toBeLessThanOrEqual(box.x + 1);

  await v.click('label[for=poll-answer-1]');
  await v.click('#poll-send');
  await expect(v.locator('#poll-status')).toHaveText('Answer sent. You can change it until answers close.');
  await expect(v.locator('#poll-send')).toHaveText('Change answer');
  await w.click('label[for=poll-answer-1]');
  await w.click('#poll-send');
  await expect(w.locator('#poll-status')).toHaveClass(/poll-status-ok/);

  await expect(result(card(p), 1)).toHaveText('2 · 100%');
  await expect(card(p)).toContainText('2 answers · 2 viewers connected');
  await expect(p.locator('#tab-poll .p-tab-count')).toHaveText('2');
  // The projector shows the results, never a form.
  await expect(proj.locator('#poll-panel.poll-display')).toBeVisible();
  await expect(proj.locator('#poll-send')).toHaveCount(0);
  await expect(result(proj, 1)).toHaveText('2 · 100%');
  // Participants do not see the results while answers are open.
  await expect(v.locator('.poll-results-box')).toBeHidden();

  // A change replaces the answer: still two answers.
  await v.click('label[for=poll-answer-2]');
  await expect(v.locator('#poll-status')).toHaveText('Your new choice is not sent yet.');
  await v.click('#poll-send');
  await expect(result(card(p), 2)).toHaveText('1 · 50%');
  await expect(result(card(p), 1)).toHaveText('1 · 50%');
  await expect(result(proj, 2)).toHaveText('1 · 50%');
  await expect(card(p)).toContainText('2 answers');

  // A reload keeps the answer.
  await v.reload();
  await expect(v.locator('#poll-answer-2')).toBeChecked();
  await expect(v.locator('#poll-status')).toHaveClass(/poll-status-ok/);
  await Promise.all([pc.close(), vc.close(), wc.close(), projc.close()]);
});

test('closing answers shows participants the results; a hidden poll comes back as it was', async ({ browser }) => {
  const { page: p, context: pc } = await presenter(browser);
  const { page: v, context: vc } = await participant(browser);
  await p.click('#poll-launch');
  await v.click('label[for=poll-answer-0]');
  await v.click('#poll-send');
  await expect(result(card(p), 0)).toHaveText('1 · 100%');

  await card(p).locator('[data-action=close]').click();
  await expect(card(p)).toContainText('Answers closed');
  await expect(v.locator('#poll-closed-note')).toHaveText('Answers are closed.');
  await expect(v.locator('.poll-form')).toBeHidden();
  await expect(result(v, 0)).toHaveText('1 · 100%');
  await expect(v.locator('.poll-result').nth(0)).toHaveClass(/poll-own/);
  await card(p).locator('[data-action=open]').click();
  await expect(v.locator('.poll-form')).toBeVisible();
  await expect(v.locator('#poll-answer-0')).toBeChecked();

  // Shown on every slide until hidden.
  await p.click('#next');
  await expect(p.locator('#counter')).toHaveText('6 / 7');
  await expect(v.locator('#poll-panel')).toBeVisible();
  await p.click('#tab-notes');
  await expect(p.locator('#poll-strip')).toContainText('On screens · 1 answer');
  await p.click('#poll-see');
  await card(p).locator('[data-action=hide]').click();
  await expect(v.locator('#poll-panel')).toBeHidden();
  await expect(v.locator('body')).not.toHaveClass(/poll-open/);
  await expect(p.locator('#tab-poll')).toBeHidden(); // nothing left to show on this slide
  await expect(p.locator('#poll-strip')).toBeHidden();

  // Back on its slide: show it again, with its answers.
  await p.click('#prev');
  await expect(p.locator('#poll-strip')).toContainText('Hidden · 1 answer');
  await p.click('#poll-launch');
  await expect(v.locator('#poll-panel')).toBeVisible();
  await expect(v.locator('#poll-answer-0')).toBeChecked();
  await expect(result(card(p), 0)).toHaveText('1 · 100%');

  // Reset asks once more, then takes it back to before it was launched.
  const reset = card(p).locator('[data-action=reset]');
  await reset.click();
  await expect(reset).toHaveText('Delete the answers?');
  await reset.click();
  await expect(v.locator('#poll-panel')).toBeHidden();
  await expect(p.locator('.p-poll-slide')).toContainText('Not launched');
  await expect(reset).toHaveText('Reset');
  await p.locator('.p-poll-slide [data-action=launch]').click();
  await expect(v.locator('#poll-panel')).toBeVisible();
  await expect(v.locator('#poll-answer-0')).not.toBeChecked();
  await expect(v.locator('#poll-send')).toHaveText('Send answer');
  await expect(card(p)).toContainText('0 answers');
  await Promise.all([pc.close(), vc.close()]);
});

test('a participant minimises the poll; it opens again when shown again; blank hides it only on the projector', async ({ browser }) => {
  const { page: p, context: pc } = await presenter(browser);
  const { page: v, context: vc } = await participant(browser);
  const { page: proj, context: projc } = await open(browser, '/demo/view', { cookie: adminCookie });
  await p.click('#poll-launch');
  await expect(v.locator('#poll-panel')).toBeVisible();

  await v.click('#poll-minimize');
  await expect(v.locator('#poll-panel')).toBeHidden();
  await expect(v.locator('#poll-pill')).toBeVisible();
  await expect(v.locator('.poll-pill-dot')).toBeVisible(); // not answered yet
  const full = await v.locator('.viewer-stage').boundingBox();
  expect(full.width).toBe(v.viewportSize().width);
  await v.click('#poll-pill');
  await expect(v.locator('#poll-panel')).toBeVisible();
  await expect(v.locator('#poll-pill')).toBeHidden();

  await v.click('#poll-minimize');
  await card(p).locator('[data-action=hide]').click();
  await expect(v.locator('#poll-pill')).toBeHidden();
  // The Poll tab is open, so its card shows it again (the strip hides meanwhile).
  await expect(p.locator('#poll-strip')).toBeHidden();
  await p.locator('.p-poll-slide [data-action=show]').click();
  await expect(v.locator('#poll-panel')).toBeVisible();
  await expect(p.locator('.badge-warn', { hasText: 'Reconnecting' })).toBeHidden();

  await p.keyboard.press('b');
  await expect(proj.locator('.blank-overlay')).toBeVisible();
  await expect(proj.locator('#poll-panel')).toBeHidden();
  await expect(v.locator('#poll-panel')).toBeVisible();
  await p.keyboard.press('b');
  await expect(proj.locator('#poll-panel')).toBeVisible();
  await Promise.all([pc.close(), vc.close(), projc.close()]);
});

test('phone held upright: the poll goes under the slide, above the participant bar', async ({ browser }) => {
  const s = srv.socket('demo', { cookie: adminCookie });
  await s.send({ t: 'poll', action: 'show', slide: 'roles' });
  const { page: v, context: vc } = await participant(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const panel = v.locator('#poll-panel');
  await expect(panel).toBeVisible();
  const stage = await v.locator('.viewer-stage').boundingBox();
  const box = await panel.boundingBox();
  const bar = await v.locator('.participant-bar').boundingBox();
  expect(stage.height).toBeLessThan(844 / 2);
  expect(Math.abs(box.y - (stage.y + stage.height))).toBeLessThanOrEqual(1);
  expect(box.width).toBe(390);
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
  await v.locator('label[for=poll-answer-2]').tap();
  await v.locator('#poll-send').tap();
  await expect(v.locator('#poll-status')).toHaveClass(/poll-status-ok/);
  s.close();
  await vc.close();
});

test('phone presenter: a strip launches the poll and "See" opens the results in a pop-up', async ({ browser }) => {
  const { page: p, context: pc } = await presenter(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const { page: v, context: vc } = await participant(browser);
  await expect(p.locator('#tab-poll')).toBeHidden();
  await p.locator('#poll-launch').tap();
  await expect(p.locator('#poll-strip')).toContainText('On screens · 0 answers');
  await expect(p.locator('#poll-dialog')).toBeHidden();
  await v.click('label[for=poll-answer-1]');
  await v.click('#poll-send');
  await expect(p.locator('#poll-strip')).toContainText('On screens · 1 answer');

  await p.locator('#poll-see').tap();
  const dialog = p.locator('#poll-dialog');
  await expect(dialog).toBeVisible();
  await expect(result(dialog, 1)).toHaveText('1 · 100%');
  await dialog.locator('[data-action=close]').tap();
  await expect(v.locator('#poll-closed-note')).toBeVisible();
  await p.locator('#poll-dialog-close').tap();
  await expect(dialog).toBeHidden();
  await expect(p.locator('#notes')).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
  await Promise.all([pc.close(), vc.close()]);
});

test('a quiz: on the next slide, its own poll replaces the one on the screens in one click', async ({ browser }) => {
  const putPoll = (poll) => srv.app.inject({
    method: 'PUT', url: '/api/admin/decks/demo/slides/keys',
    headers: { host: 'localhost', origin: 'http://localhost', cookie: `sc_session=${adminCookie}` },
    payload: { notes: '`B` blanks every viewer screen. Press it again to come back.', steps: {}, poll },
  });
  expect((await putPoll({ question: 'Which key blanks the screen?', options: ['B', 'F'] })).statusCode).toBe(200);
  const { page: p, context: pc } = await presenter(browser);
  const { page: v, context: vc } = await participant(browser);
  await p.click('#poll-launch');
  await v.click('label[for=poll-answer-1]');
  await v.click('#poll-send');
  await p.click('#tab-notes');
  await p.click('#next');
  await expect(p.locator('#poll-strip')).toContainText('On screens · 1 answer');
  await expect(p.locator('#poll-launch')).toHaveText('Launch poll');
  await p.click('#poll-launch');
  await expect(v.locator('.poll-question')).toHaveText('Which key blanks the screen?');
  await expect(v.locator('#poll-send')).toHaveText('Send answer');
  // The first one waits, hidden, with its answer.
  await expect(p.locator('.p-poll-shown .p-poll-question')).toHaveText('Which key blanks the screen?');
  await p.click('#prev');
  await expect(p.locator('#poll-strip')).toContainText('On screens · 0 answers');
  await expect(p.locator('#poll-launch')).toHaveText('Show again');
  await p.click('#tab-poll');
  await expect(p.locator('.p-poll-slide')).toContainText('Hidden');
  await expect(p.locator('.p-poll-slide')).toContainText('1 answer');
  expect((await putPoll(null)).statusCode).toBe(200);
  await Promise.all([pc.close(), vc.close()]);
});

test('closing the room takes the poll away from participants; reopened, nothing is left', async ({ browser }) => {
  const { page: p, context: pc } = await presenter(browser);
  const { page: v, context: vc } = await participant(browser);
  await p.click('#poll-launch');
  await v.click('label[for=poll-answer-0]');
  await v.click('#poll-send');
  await expect(result(card(p), 0)).toHaveText('1 · 100%');
  await patchRoom({ open: false });
  await expect(v.locator('.room-notice')).toContainText('This room is closed');
  await expect(v.locator('#poll-panel')).toBeHidden();
  await expect(p.locator('.p-poll-shown')).toBeHidden();
  await patchRoom({ open: true });
  await expect(v.locator('.room-notice')).toBeHidden(); // the page reloads and joins again
  await expect(v.locator('#who')).toBeVisible();
  await expect(v.locator('#poll-panel')).toBeHidden();
  await Promise.all([pc.close(), vc.close()]);
});

// A participant from the test process that keeps changing its answer.
function busyVoter() {
  const ws = new WebSocket(`${srv.url.replace('http', 'ws')}/ws/demo?role=viewer`, { headers: { Origin: srv.url } });
  let poll = null;
  let i = 0;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', token: null }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'poll') poll = m.poll;
  };
  const timer = setInterval(() => {
    if (poll?.open && ws.readyState === 1) ws.send(JSON.stringify({ t: 'vote', id: poll.id, choice: [i++ % 3] }));
  }, 250);
  return { close() { clearInterval(timer); ws.close(); } };
}

test('while answers stream in, the presenter\'s buttons keep the focus and Enter acts on them, not on the slides', async ({ browser }) => {
  const { page: p, context: pc } = await presenter(browser);
  await p.click('#poll-launch');
  const voters = [busyVoter(), busyVoter(), busyVoter()];
  await expect(card(p)).toContainText('3 answers');
  const toggle = card(p).locator('[data-action=close]');
  await toggle.focus();
  await p.waitForTimeout(800); // several updates of the counts
  expect(await p.evaluate(() => document.activeElement?.dataset.action)).toBe('close');
  await p.keyboard.press('Enter');
  await expect(card(p)).toContainText('Answers closed');
  await expect(p.locator('#counter')).toHaveText('5 / 7');
  for (const v of voters) v.close();
  await pc.close();
});
