import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from './server.js';

// Contest mode (0009). The demo deck's "roles" slide (step 5 of 7) gets a
// poll with a right answer; "keys" (step 6) a several-answer one.
// Both passwords set, so a loopback browser without a session is a plain
// participant; the admin's cookie gives presenter and admin rights.
let srv;
let adminCookie;
test.beforeAll(async () => {
  srv = await startServer({ passwords: { presenter: 'presenter-pass1', admin: 'admin-password1' } });
  adminCookie = await srv.login('admin', 'admin-password1');
});
test.afterAll(async () => srv?.close());

const ADMIN = () => ({ host: 'localhost', origin: 'http://localhost', cookie: `sc_session=${adminCookie}` });

// Pages of a test close with it, so they never come back into the next
// test's room (a reopened room reloads them).
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

// A presenter connection from the test, keeping every message.
function presenterWs() {
  const ws = new WebSocket(`${srv.url.replace('http', 'ws')}/ws/demo?role=presenter`, { headers: { Origin: srv.url, Cookie: `sc_session=${adminCookie}` } });
  const messages = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    messages.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  const opened = new Promise((r) => { ws.onopen = r; });
  return {
    async send(msg) { await opened; ws.send(JSON.stringify(msg)); },
    next(pred, timeout = 5000) {
      const hit = [...messages].reverse().find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no matching message')), timeout);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
}

async function participant(browser, name) {
  const page = await open(browser, '/demo/view');
  await expect(page.locator('.join-dialog')).toBeVisible();
  if (name) {
    await page.fill('#join-name', name);
    await page.click('#join-enter');
    await expect(page.locator('#who')).toContainText(name);
    await expect(page.locator('.join-dialog')).toBeHidden();
  }
  return page;
}

const deckFile = () => join(srv.dataDir, 'demo', 'deck.json');
const deckJson = async () => JSON.parse(await readFile(deckFile(), 'utf8'));
const ROLES = { question: 'Which role presents?', options: ['Viewer', 'Presenter', 'Admin'], multiple: false, correct: [1] };
const KEYS = { question: 'Which keys move?', options: ['Left', 'Right', 'Q', 'Space'], multiple: true, correct: [0, 1, 3] };

async function setDeck(contest, polls = {}) {
  const meta = await deckJson();
  meta.contest = contest;
  meta.slides.roles = { ...meta.slides.roles, poll: polls.roles ?? ROLES };
  meta.slides.keys = { ...meta.slides.keys, poll: polls.keys ?? KEYS };
  await writeFile(deckFile(), JSON.stringify(meta));
  srv.app.slidecast.live.resetDeck('demo');
  // A fresh room: closing it forgets every poll and participant.
  for (const open of [false, true]) {
    await srv.app.inject({ method: 'PATCH', url: '/api/admin/rooms/demo', headers: ADMIN(), payload: { open } });
  }
}

test('admin turns contest mode on in the deck settings; the name box is locked while it is on', async ({ browser }) => {
  await setDeck({ on: false });
  const page = await open(browser, '/admin', { cookie: adminCookie });
  await page.click('tr[data-slug=demo] button:has-text("Settings")');
  await expect(page.locator('#contest-points')).toBeDisabled();
  await page.check('#contest-on');
  await expect(page.locator('#contest-points')).toBeEnabled();
  await expect(page.locator('#room-names')).toBeChecked();
  await expect(page.locator('#room-names')).toBeDisabled();
  await expect(page.locator('#contest-names-hint')).toBeVisible();
  await expect(page.locator('#contest-hint')).toContainText('1,000');
  await expect(page.locator('#contest-hint')).toContainText('500');
  await page.fill('#contest-speed', '20');
  await expect(page.locator('#contest-hint')).toContainText('800');
  await page.check('#contest-no-time');
  await expect(page.locator('#contest-time')).toBeDisabled();
  await page.click('.deck-settings button.primary');
  await expect(page.locator('.deck-settings .status.ok')).toHaveText('Saved');
  expect((await deckJson()).contest).toEqual({ on: true, points: 1000, time: null, speed: 20 });
  const room = srv.app.slidecast.rooms.settings('demo');
  expect(room.askNames).toBe(true);
});

test('the editor sets a poll\'s points, countdown and whether it counts; editing with contest off keeps them', async ({ browser }) => {
  await setDeck({ on: true, points: 1000, time: 30, speed: 50 }, { roles: { ...ROLES, points: 2000 } });
  const page = await open(browser, '/admin/edit/demo', { cookie: adminCookie });
  await page.click('.e-step[data-index="4"]');
  await expect(page.locator('#poll-question')).toHaveValue(ROLES.question);
  await expect(page.locator('#poll-fixed')).toBeHidden();
  await expect(page.locator('#poll-points')).toBeEnabled();
  await expect(page.locator('#poll-points')).toHaveValue('2000');
  await expect(page.locator('#poll-time-mode option').first()).toHaveText('Deck default (30 s)');
  await page.selectOption('#poll-time-mode', 'custom');
  await page.fill('#poll-time', '60');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  expect((await deckJson()).slides.roles.poll).toMatchObject({ points: 2000, time: 60 });
  // Out of range: marked, and the last valid value stays.
  await page.fill('#poll-points', '20000');
  await expect(page.locator('#poll-range')).toHaveText('Points go from 1 to 10000; until then the last valid value stays.');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  expect((await deckJson()).slides.roles.poll.points).toBe(2000);
  await page.fill('#poll-points', '2000');
  await expect(page.locator('#poll-range')).toBeHidden();
  await page.uncheck('#poll-counts');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  expect((await deckJson()).slides.roles.poll.contest).toBe(false);

  // Several answers: what a wrong tick costs.
  await page.click('.e-step[data-index="5"]');
  await expect(page.locator('#poll-wrong-cost')).toHaveText('Each wrong option ticked takes away 1/1 of the points.');

  // Contest off: the fields are disabled, and editing the question keeps them.
  await setDeck({ on: false }, { roles: { ...ROLES, points: 2000 } });
  await page.reload();
  await page.click('.e-step[data-index="4"]');
  await expect(page.locator('#poll-points')).toBeDisabled();
  await expect(page.locator('#poll-contest-off')).toBeVisible();
  await page.fill('#poll-question', 'Which role presents slides?');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  expect((await deckJson()).slides.roles.poll).toMatchObject({ question: 'Which role presents slides?', points: 2000 });
});

test('a participant needs a free name; one tap answers; the phone explains its points and shows its place', async ({ browser }) => {
  await setDeck({ on: true, points: 1000, time: null, speed: 0 });
  const ana = await open(browser, '/demo/view');
  await expect(ana.locator('.join-dialog')).toBeVisible();
  await expect(ana.locator('#join-anonymous')).toBeHidden();
  await expect(ana.locator('#join-rules')).toBeVisible();
  await ana.click('#join-enter');
  await expect(ana.locator('#join-error')).toHaveText('Contest mode: enter a name to answer.');
  await ana.fill('#join-name', 'Ana');
  await ana.click('#join-enter');
  await expect(ana.locator('.join-dialog')).toBeHidden();
  await expect(ana.locator('#who')).toContainText('Ana');

  const taken = await open(browser, '/demo/view');
  await taken.fill('#join-name', 'ANA');
  await taken.click('#join-enter');
  await expect(taken.locator('#join-error')).toHaveText('That name is already taken; add an initial.');
  await expect(taken.locator('.join-dialog')).toBeVisible();
  await taken.fill('#join-name', 'Bea');
  await taken.click('#join-enter');
  await expect(taken.locator('.join-dialog')).toBeHidden();
  const bea = taken;

  const p = presenterWs();
  await p.send({ t: 'goto', index: 4 });
  await p.send({ t: 'poll', action: 'show', slide: 'roles' });
  await expect(ana.locator('#poll-contest-line')).toHaveText('Up to 1,000 points');
  await expect(ana.locator('.poll-actions')).toBeHidden();
  // Two quick taps: the last one is the answer the server keeps.
  await ana.click('label[for=poll-answer-0]');
  await ana.click('label[for=poll-answer-1]');
  await expect(ana.locator('#poll-status')).toContainText('Answer sent');
  await expect(ana.locator('#poll-answer-1')).toBeChecked();
  await bea.click('label[for=poll-answer-0]');
  // Everyone answered: answers close by themselves, results secret.
  await expect(ana.locator('#poll-closed-note')).toBeVisible();
  await p.send({ t: 'poll', action: 'reveal', slide: 'roles' });
  await expect(ana.locator('#poll-verdict')).toContainText('Correct!');
  await expect(ana.locator('#poll-score')).toHaveText('Right answer → +1,000 of 1,000');
  await expect(bea.locator('#poll-score')).toHaveText('Wrong answer → +0 of 1,000');
  await expect(ana.locator('#score')).toHaveText('1,000 pts · 1º of 2');
  await expect(bea.locator('#score')).toHaveText('0 pts · 2º of 2');

  // The presenter asks Bea for another name.
  const ranking = await p.next((m) => m.t === 'ranking' && m.rows.length === 2);
  await p.send({ t: 'contest', action: 'rename', id: ranking.rows.find((r) => r.name === 'Bea').id });
  await expect(bea.locator('#join-notice')).toHaveText('The presenter asked you to pick another name.');
  await expect(bea.locator('#join-name')).toHaveValue('');
  // A reload before choosing asks again.
  await bea.reload();
  await expect(bea.locator('.join-dialog')).toBeVisible();
  await expect(bea.locator('#join-notice')).toHaveText('The presenter asked you to pick another name.');
  p.close();
});

test('the projector shows the countdown, and the top 10 when the presenter shows it', async ({ browser }) => {
  await setDeck({ on: true, points: 1000, time: null, speed: 0 }, { keys: { ...KEYS, time: 5 } });
  const proj = await open(browser, '/demo/view', { cookie: adminCookie });
  const ana = await participant(browser, 'Ana');
  const bea = await participant(browser, 'Bea');
  const p = presenterWs();
  await p.send({ t: 'goto', index: 5 });
  await p.send({ t: 'poll', action: 'show', slide: 'keys' });
  await expect(proj.locator('#poll-countdown')).toBeVisible();
  await expect(proj.locator('#poll-countdown')).toHaveText(/^\d s$/);
  await expect(ana.locator('#poll-countdown')).toBeVisible();
  // Several answers: ticks, then Send.
  for (const i of [0, 1, 3]) await ana.check(`#poll-answer-${i}`);
  await expect(ana.locator('#poll-status')).toHaveText('Not sent yet');
  await ana.click('#poll-send');
  await expect(ana.locator('#poll-status')).toContainText('Answer sent');
  await bea.check('#poll-answer-2');
  // The countdown closes answers by itself.
  await expect(ana.locator('#poll-closed-note')).toBeVisible({ timeout: 8000 });
  await p.send({ t: 'poll', action: 'reveal', slide: 'keys' });
  await expect(ana.locator('#poll-score')).toHaveText('You got 3 of 3 right answers → +1,000 of 1,000');
  await expect(bea.locator('#poll-score')).toHaveText("You didn't answer: +0");
  await p.send({ t: 'contest', action: 'show-ranking' });
  await expect(proj.locator('#ranking')).toBeVisible();
  await expect(proj.locator('#ranking .ranking-row').first()).toContainText('Ana');
  await expect(proj.locator('#ranking .ranking-row').first()).toContainText('1,000 pts');
  await expect(proj.locator('#poll-panel')).toBeHidden();
  await p.send({ t: 'contest', action: 'hide-ranking' });
  await expect(proj.locator('#ranking')).toBeHidden();
  p.close();
});

const card = (page) => page.locator('.p-poll-shown');

async function presenterPage(browser, opts = {}) {
  const page = await open(browser, '/demo/present', { cookie: adminCookie, ...opts });
  await expect(page.locator('#counter')).toHaveText(/ \/ 7$/);
  return page;
}

test('presenter: chips, countdown, show results then ranking in sight, Ranking tab, CSV and restart', async ({ browser }) => {
  await setDeck({ on: true, points: 1000, time: null, speed: 0 }, { keys: { ...KEYS, time: 5 } });
  const p = await presenterPage(browser);
  const proj = await open(browser, '/demo/view', { cookie: adminCookie });
  const ana = await participant(browser, 'Ana');
  const bea = await participant(browser, 'Bea');
  await expect(p.locator('#tab-ranking')).toBeVisible();

  // Several answers with a 5 s countdown; nobody answers, so it closes by itself.
  const ctl = presenterWs();
  await ctl.send({ t: 'goto', index: 5 });
  await expect(p.locator('#counter')).toHaveText('6 / 7');
  await expect(p.locator('.p-poll-chip-contest').first()).toHaveText('Contest · 1,000 pts · 5 s');
  await p.click('#poll-launch');
  await expect(card(p).locator('.p-poll-countdown')).toHaveText(/^\d s$/);
  // Someone joining (a room message) does not wind the countdown back.
  await expect(card(p).locator('.p-poll-countdown')).toHaveText(/^[1-3] s$/);
  const before = Number((await card(p).locator('.p-poll-countdown').textContent()).split(' ')[0]);
  const cid = await participant(browser, 'Cid');
  const after = Number((await card(p).locator('.p-poll-countdown').textContent()).split(' ')[0] || 0);
  expect(after).toBeLessThanOrEqual(before);
  await cid.context().close(); // gone again: Ana and Bea are everyone
  await expect(card(p)).toContainText('Answers closed', { timeout: 8000 });
  await expect(card(p).locator('.p-poll-actions button:visible')).toHaveText(['Show results', 'Take off the screens', 'More options']);
  await expect(card(p).locator('.p-poll-timeup')).toBeVisible();

  // Launching another poll over a question not scored yet asks first.
  await ctl.send({ t: 'goto', index: 4 });
  await expect(p.locator('#counter')).toHaveText('5 / 7');
  await expect(p.locator('.p-poll-chip-contest').last()).toHaveText('Contest · 1,000 pts');
  const launchHere = p.locator('.p-poll-slide [data-action=launch]');
  await launchHere.click();
  await expect(p.locator('#poll-confirm')).toHaveText('The previous question has not scored yet. Launch anyway?');
  await launchHere.click();
  await ana.click('label[for=poll-answer-1]');
  await bea.click('label[for=poll-answer-0]');
  await expect(card(p)).toContainText('Answers closed'); // everyone answered

  // The Ranking tab lists the unscored question; showing its results scores it.
  await p.click('#tab-ranking');
  await expect(p.locator('#ranking-unscored')).toContainText('Which role presents?');
  await p.locator('#ranking-unscored button[data-slide=roles]').click();
  await expect(p.locator('#ranking-rows .p-ranking-row')).toHaveCount(2);
  await expect(p.locator('#ranking-rows .p-ranking-row').nth(0)).toContainText('Ana');
  await expect(p.locator('#ranking-rows .p-ranking-row').nth(0)).toContainText('1,000 pts');
  await expect(p.locator('#ranking-rows .p-ranking-row').nth(1)).toContainText('Bea');
  await expect(p.locator('#ranking-unscored')).toContainText('Which keys move?');

  // Back on the poll: "Show ranking" in sight puts the top 10 on the screens.
  await p.click('#tab-poll');
  await card(p).locator('[data-action=show-ranking]').focus();
  await p.keyboard.press('Enter');
  await expect(proj.locator('#ranking')).toBeVisible();
  // Still in the Poll tab: it says so, and "Take off" has the focus.
  await expect(p.locator('#poll-ranking-on')).toBeVisible();
  await expect(p.locator('#ranking-off-panel')).toBeFocused();
  await p.keyboard.press('Enter');
  await expect(proj.locator('#ranking')).toBeHidden();
  await expect(p.locator('#counter')).toHaveText('5 / 7'); // Enter never moved the slide
  // From the Notes tab, the strip does the same.
  await p.click('#tab-poll');
  await expect(card(p)).toBeHidden();
  await ctl.send({ t: 'contest', action: 'show-ranking' });
  await p.click('#tab-notes');
  await expect(p.locator('#poll-strip')).toContainText('Ranking on the screens');
  await p.click('#ranking-off');
  await expect(proj.locator('#ranking')).toBeHidden();

  // CSV in the presenter's language, then a restart that asks first.
  await p.click('#tab-ranking');
  const [download] = await Promise.all([p.waitForEvent('download'), p.click('#ranking-csv')]);
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv.startsWith('﻿"Position";"Name";"Number";"Points";"Right";"Answered"')).toBe(true);
  expect(csv).toContain('"Ana"');
  await p.click('#ranking-restart');
  await expect(p.locator('.p-ranking-restart')).toContainText('All points will be erased.');
  await p.click('#ranking-restart-go');
  await expect(p.locator('#ranking-rows')).toContainText('No question has scored yet');
  await expect(ana.locator('#score')).toHaveText('0 pts · not ranked yet');
  ctl.close();
});

test('presenter on a phone: the Ranking opens from More', async ({ browser }) => {
  await setDeck({ on: true, points: 1000, time: null, speed: 0 });
  const p = await presenterPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await expect(p.locator('#tab-ranking')).toBeHidden();
  await p.click('#more');
  await p.click('#ranking-open');
  await expect(p.locator('#ranking-dialog')).toBeVisible();
  await expect(p.locator('#ranking-dialog #ranking-panel')).toBeVisible();
  await p.click('#ranking-dialog-close');
  await expect(p.locator('#ranking-dialog')).toBeHidden();
});

// Participants over WebSocket, to fill a ranking quickly.
function participantWs(name) {
  const ws = new WebSocket(`${srv.url.replace('http', 'ws')}/ws/demo?role=viewer`, { headers: { Origin: srv.url } });
  const messages = [];
  ws.onmessage = (e) => messages.push(JSON.parse(e.data));
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', token: null }));
  const until = async (pred) => {
    for (let i = 0; i < 100; i++) {
      const m = messages.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${name}: no matching message`);
  };
  return {
    async ready() {
      await until((m) => m.t === 'you');
      ws.send(JSON.stringify({ t: 'name', name }));
      await until((m) => m.t === 'you' && m.name === name);
    },
    async vote(choice) {
      const { poll } = await until((m) => m.t === 'poll' && m.poll?.open);
      ws.send(JSON.stringify({ t: 'vote', id: poll.id, choice }));
      await until((m) => m.t === 'poll' && m.ack);
    },
    close: () => ws.close(),
  };
}

test('the projector fits all ten rows of the top 10', async ({ browser }) => {
  await setDeck({ on: true, points: 1000, time: null, speed: 50 });
  const people = Array.from({ length: 12 }, (_, i) => participantWs(`Player ${String(i + 1).padStart(2, '0')}`));
  for (const x of people) await x.ready();
  const ctl = presenterWs();
  await ctl.send({ t: 'goto', index: 4 });
  await ctl.send({ t: 'poll', action: 'show', slide: 'roles' });
  for (const x of people) await x.vote([1]);
  await ctl.send({ t: 'poll', action: 'close', slide: 'roles', results: true });
  await ctl.send({ t: 'contest', action: 'show-ranking' });
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 1366, height: 768 }]) {
    const proj = await open(browser, '/demo/view', { cookie: adminCookie, viewport });
    await expect(proj.locator('#ranking')).toBeVisible();
    await expect(proj.locator('#ranking .ranking-row')).toHaveCount(10);
    const last = await proj.locator('#ranking .ranking-row').nth(9).boundingBox();
    expect(last.y + last.height, `${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(viewport.height);
  }
  for (const x of people) x.close();
  ctl.close();
});
