import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildServer } from '../src/server.js';
import { onCleanup, tempDirs, makeDeck, listen, wsClient, openRooms } from './helpers.js';

// Contest mode over the WebSocket and the CSV route (0009, T3–T5).

const LOCAL = { host: 'localhost:4321', origin: 'http://localhost:4321' };
const PROXIED = { 'X-Forwarded-For': '203.0.113.50' };
const ONE = { question: 'Which planet is largest?', options: ['Mars', 'Jupiter', 'Venus'], correct: [1] };
const OPINION = { question: 'Like it?', options: ['yes', 'no'] };

// `clock`: a fake monotonic clock the test moves (null: the real one).
async function setup(t, { contest = { on: true, points: 1000, time: 20, speed: 50 }, clock = { ms: 0 }, graceMs = 200 } = {}) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk', { meta: { slidecast: 1, contest, slides: { quiz: { poll: ONE }, other: { poll: { ...ONE, question: 'Again?' } }, opinion: { poll: OPINION } } } });
  const app = await buildServer({ ...dirs, graceMs, ...(clock ? { now: () => clock.ms } : {}) });
  await openRooms(app, ['talk']);
  const urls = await listen(app);
  const clients = [];
  const ws = (role, o = {}) => {
    const c = wsClient(`${urls.ws}/ws/talk?role=${role}`, o);
    clients.push(c);
    return c;
  };
  const presenter = async () => {
    const c = ws('presenter');
    await c.next((m) => m.t === 'polls');
    return c;
  };
  const display = () => ws('viewer');
  // A participant, through a proxy; `name` sent once it joined.
  const viewer = async (name, token = true) => {
    const c = ws('viewer', { join: token, headers: PROXIED });
    const you = await c.next((m) => m.t === 'you');
    c.token = you.token ?? token;
    c.n = you.n;
    c.you = you;
    if (name !== undefined) {
      c.send({ t: 'name', name });
      if (name) await c.next((m) => m.t === 'you' && m.name === name);
    }
    return c;
  };
  onCleanup(t, async () => {
    for (const c of clients) c.close();
    await app.close();
  });
  const onDisk = async () => JSON.parse(await readFile(join(dirs.dataDir, 'talk', 'deck.json'), 'utf8'));
  return { app, dirs, urls, presenter, display, viewer, clock, onDisk, ctx: app.slidecast };
}

const isPoll = (pred = () => true) => (m) => m.t === 'poll' && pred(m);
const isError = (code) => (m) => m.t === 'error' && m.code === code;
const isRanking = (pred = () => true) => (m) => m.t === 'ranking' && pred(m);
const isScore = (pred = () => true) => (m) => m.t === 'score' && pred(m);

async function launch(p, v, slide = 'quiz') {
  p.send({ t: 'poll', action: 'show', slide });
  return (await v.next(isPoll((m) => m.poll))).poll;
}

test('contest mode needs a name, unique in the room; askNames off keeps names, contest off then wipes them', async (t) => {
  const { app, presenter, viewer } = await setup(t);
  const p = await presenter();
  const anon = await viewer();
  const poll = await launch(p, anon);
  anon.send({ t: 'vote', id: poll.id, choice: [1] });
  assert.equal((await anon.next(isError('name-needed'))).about, 'poll');
  anon.send({ t: 'name', name: '   ' });
  await anon.next(isError('name-needed'));

  const ana = await viewer('Ana');
  anon.send({ t: 'name', name: 'ANA' });
  assert.equal((await anon.next(isError('name-taken'))).offline, false);
  ana.close();
  await sleep(50);
  anon.send({ t: 'name', name: 'ana' });
  assert.equal((await anon.next(isError('name-taken'))).offline, true, 'its owner is offline (still in its grace time)');

  const bea = await viewer('Bea');
  await app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload: { askNames: false } });
  await sleep(100);
  assert.equal(bea.messages.some((m) => m.t === 'you' && m.name === null), false, 'contest on: names stay');
  await app.inject({ method: 'PATCH', url: '/api/admin/decks/talk', headers: LOCAL, payload: { contest: { on: false } } });
  await bea.next((m) => m.t === 'you' && m.name === null);
});

test('a named participant who answered is kept offline and comes back with its points; others expire', async (t) => {
  const { app, presenter, viewer } = await setup(t, { graceMs: 150 });
  const p = await presenter();
  const ana = await viewer('Ana');
  const nobody = await viewer('Nobody');
  const poll = await launch(p, ana);
  ana.send({ t: 'vote', id: poll.id, choice: [1] });
  await ana.next(isPoll((m) => m.ack));
  p.send({ t: 'poll', action: 'close', slide: 'quiz', results: true });
  await ana.next(isScore((m) => m.points === 1000));
  ana.close();
  nobody.close();
  await sleep(400);
  const room = await p.next((m) => m.t === 'room' && m.people.length === 1, 3000);
  assert.deepEqual(room.people.map((x) => [x.name, x.online]), [['Ana', false]]);

  const back = await viewer(undefined, ana.token);
  assert.equal(back.n, ana.n);
  const score = await back.next(isScore());
  assert.deepEqual([score.points, score.pos, score.of], [1000, 1, 1]);
  back.close();
  await sleep(50);
  await app.inject({ method: 'PATCH', url: '/api/admin/decks/talk', headers: LOCAL, payload: { contest: { on: false } } });
  await p.next((m) => m.t === 'room' && m.people.length === 0, 3000);
});

test('the presenter can ask for another name: points stay, the phone is asked', async (t) => {
  const { presenter, viewer } = await setup(t);
  const p = await presenter();
  const ana = await viewer('Rude');
  const poll = await launch(p, ana);
  ana.send({ t: 'vote', id: poll.id, choice: [1] });
  await ana.next(isPoll((m) => m.ack));
  p.send({ t: 'poll', action: 'close', slide: 'quiz', results: true });
  const { rows } = await p.next(isRanking((m) => m.rows.length === 1));
  p.send({ t: 'contest', action: 'rename', id: rows[0].id });
  const you = await ana.next((m) => m.t === 'you' && m.renameAsked);
  assert.equal(you.name, null);
  const after = await p.next(isRanking((m) => m.rows[0]?.name === null));
  assert.equal(after.rows[0].points, 1000);
  ana.send({ t: 'name', name: 'Nice' });
  await p.next(isRanking((m) => m.rows[0]?.name === 'Nice'));
});

test('new contest settings in a replaced deck apply live', async (t) => {
  const { dirs, ctx, presenter } = await setup(t);
  const p = await presenter();
  const meta = JSON.parse(await readFile(join(dirs.dataDir, 'talk', 'deck.json'), 'utf8'));
  meta.contest = { on: false };
  await writeFile(join(dirs.dataDir, 'talk', 'deck.json'), JSON.stringify(meta));
  ctx.live.resetDeck('talk');
  await p.next((m) => m.t === 'state' && m.contest === false);
});

test('a countdown closes answers by itself, results secret; closing the room cancels it', async (t) => {
  const { app, presenter, viewer } = await setup(t, { contest: { on: true, time: 5 }, clock: null });
  const p = await presenter();
  const ana = await viewer('Ana');
  const poll = await launch(p, ana);
  assert.ok(poll.left > 4000 && poll.left <= 5000, `left ${poll.left}`);
  const closed = await ana.next(isPoll((m) => m.poll && !m.poll.open), 8000);
  assert.equal(closed.poll.revealed, false);

  // Closing the room cancels the countdown: nothing comes back from it. (A
  // stale timer could not close a new run anyway: expire() checks the clock.)
  p.send({ t: 'poll', action: 'show', slide: 'other' });
  await ana.next(isPoll((m) => m.poll?.question === 'Again?' && m.poll.open));
  await app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload: { open: false } });
  await app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload: { open: true } });
  const before = p.messages.length;
  await sleep(6500);
  const late = p.messages.slice(before).filter((m) => m.t === 'polls' && m.runs.length);
  assert.deepEqual(late, [], 'no poll came back from the old countdown');
});

test('answers close by themselves once every named participant online has answered', async (t) => {
  const { presenter, viewer } = await setup(t);
  const p = await presenter();
  const ana = await viewer('Ana');
  const bea = await viewer('Bea');
  const poll = await launch(p, ana);
  ana.send({ t: 'vote', id: poll.id, choice: [1] });
  await ana.next(isPoll((m) => m.ack));
  assert.equal(ana.messages.some((m) => m.t === 'poll' && m.poll && !m.poll.open), false);
  bea.send({ t: 'vote', id: poll.id, choice: [0] });
  const closed = await ana.next(isPoll((m) => m.poll && !m.poll.open));
  assert.equal(closed.poll.revealed, false);
});

test('ranking: presenters live, displays the top 10 once shown, each phone its own points and place', async (t) => {
  const { clock, presenter, display, viewer } = await setup(t);
  const p = await presenter();
  const proj = display();
  await proj.next(isRanking());
  const ana = await viewer('Ana');
  const bea = await viewer('Bea');
  const cid = await viewer('Cid');
  const poll = await launch(p, ana);
  clock.ms = 10_000;
  ana.send({ t: 'vote', id: poll.id, choice: [1] });
  await ana.next(isPoll((m) => m.ack));
  clock.ms = 20_000;
  bea.send({ t: 'vote', id: poll.id, choice: [1] });
  await bea.next(isPoll((m) => m.ack));
  p.send({ t: 'poll', action: 'close', slide: 'quiz', results: false });
  const pending = await p.next(isRanking((m) => m.unscored.length === 1));
  assert.deepEqual([pending.unscored, pending.rows], [['quiz'], []]);
  p.send({ t: 'poll', action: 'reveal', slide: 'quiz' });
  const ranked = await p.next(isRanking((m) => m.rows.length === 2));
  assert.deepEqual(ranked.rows.map((r) => [r.name, r.points, r.pos, r.answered, r.right]), [['Ana', 750, 1, 1, 1], ['Bea', 500, 2, 1, 1]]);
  assert.deepEqual([ranked.counted, ranked.unscored, ranked.shown], [1, [], false]);
  const mine = await ana.next(isScore((m) => m.points === 750));
  assert.deepEqual([mine.pos, mine.of, mine.last.points, mine.last.c, mine.last.t, mine.last.T], [1, 2, 750, 1, 10_000, 20_000]);
  const none = await cid.next(isScore((m) => m.of === 2));
  assert.deepEqual([none.points, none.pos, none.of], [0, null, 2]);
  assert.ok(proj.messages.filter((m) => m.t === 'ranking').every((m) => m.rows.length === 0), 'not on the screens yet');

  p.send({ t: 'contest', action: 'show-ranking' });
  const top = await proj.next(isRanking((m) => m.shown));
  assert.deepEqual(top.rows, [{ pos: 1, name: 'Ana', points: 750 }, { pos: 2, name: 'Bea', points: 500 }]);
  assert.equal(top.total, 2);
  await proj.next((m) => m.t === 'polls' && m.shown === null);

  const late = display();
  assert.equal((await late.next(isRanking())).rows.length, 2, 'a display connecting now sees it');
  p.send({ t: 'goto', index: 1 });
  await proj.next(isRanking((m) => !m.shown));

  p.send({ t: 'contest', action: 'restart' });
  await p.next(isRanking((m) => m.rows.length === 0 && m.counted === 0));
  await ana.next(isScore((m) => m.points === 0 && m.pos === null));
});

test('contest commands: refused without contest mode, from participants, and reopening a used-up countdown', async (t) => {
  const { app, clock, presenter, viewer } = await setup(t);
  const p = await presenter();
  const ana = await viewer('Ana');
  await launch(p, ana);
  clock.ms = 25_000;
  p.send({ t: 'poll', action: 'close', slide: 'quiz' });
  await ana.next(isPoll((m) => m.poll && !m.poll.open));
  p.send({ t: 'poll', action: 'open', slide: 'quiz' });
  await p.next(isError('time-up'));
  ana.send({ t: 'contest', action: 'show-ranking' });
  await ana.next(isError('forbidden'));
  await app.inject({ method: 'PATCH', url: '/api/admin/decks/talk', headers: LOCAL, payload: { contest: { on: false } } });
  p.send({ t: 'contest', action: 'show-ranking' });
  await p.next(isError('contest-off'));
  p.send({ t: 'contest', action: 'dance' });
  await p.next(isError('bad-message'));
});

test('the ranking downloads as a spreadsheet for presenters only, safe from formulas', async (t) => {
  const { app, urls, presenter, viewer } = await setup(t);
  const p = await presenter();
  const evil = await viewer('=1+1');
  const poll = await launch(p, evil);
  evil.send({ t: 'vote', id: poll.id, choice: [1] });
  await evil.next(isPoll((m) => m.ack));
  p.send({ t: 'poll', action: 'close', slide: 'quiz', results: true });
  await evil.next(isScore((m) => m.points === 1000));

  const outsider = await fetch(`${urls.http}/api/decks/talk/contest.csv`, { headers: PROXIED });
  assert.equal(outsider.status, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/decks/nope/contest.csv', headers: LOCAL })).statusCode, 404);
  let res = await app.inject({ method: 'GET', url: '/api/decks/talk/contest.csv', headers: LOCAL });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/csv/);
  assert.match(res.headers['content-disposition'], /^attachment; filename="talk-ranking-\d{4}-\d{2}-\d{2}\.csv"$/);
  const lines = res.body.split('\r\n');
  assert.equal(lines[0], '﻿"Position";"Name";"Number";"Points";"Right";"Answered";"Which planet is largest?"');
  assert.equal(lines[1], `"1";"'=1+1";"${evil.n}";"1000";"1";"1";"1000"`);
  res = await app.inject({ method: 'GET', url: '/api/decks/talk/contest.csv?lang=es', headers: LOCAL });
  assert.ok(res.body.startsWith('﻿"Puesto";"Nombre";"Número";"Puntos";"Aciertos";"Respondidas"'));
});

test('a participant asked for another name keeps its points while offline, and is asked again when it comes back', async (t) => {
  const { presenter, viewer } = await setup(t, { graceMs: 150 });
  const p = await presenter();
  const rude = await viewer('Rude');
  const poll = await launch(p, rude);
  rude.send({ t: 'vote', id: poll.id, choice: [1] });
  await rude.next(isPoll((m) => m.ack));
  p.send({ t: 'poll', action: 'close', slide: 'quiz', results: true });
  const { rows } = await p.next(isRanking((m) => m.rows.length === 1));
  p.send({ t: 'contest', action: 'rename', id: rows[0].id });
  await rude.next((m) => m.t === 'you' && m.renameAsked);
  rude.close();
  await sleep(400);
  const room = await p.next((m) => m.t === 'room' && m.people.length === 1 && !m.people[0].online, 3000);
  assert.equal(room.people[0].name, null);
  const back = await viewer(undefined, rude.token);
  assert.equal(back.you.renameAsked, true, 'asked again on joining');
  assert.equal((await back.next(isScore())).points, 1000);
  // Back online in the presenter's ranking without anything else changing.
  await p.next(isRanking((m) => m.rows[0]?.online === true));
});

test('after reopening, a changed answer does not close the poll for those who have not changed theirs', async (t) => {
  const { clock, presenter, viewer } = await setup(t);
  const p = await presenter();
  const ana = await viewer('Ana');
  const bea = await viewer('Bea');
  const poll = await launch(p, ana);
  ana.send({ t: 'vote', id: poll.id, choice: [1] });
  await ana.next(isPoll((m) => m.ack));
  bea.send({ t: 'vote', id: poll.id, choice: [0] });
  await bea.next(isPoll((m) => m.poll && !m.poll.open));
  clock.ms = 5000;
  p.send({ t: 'poll', action: 'open', slide: 'quiz' });
  await bea.next(isPoll((m) => m.poll?.open));
  ana.send({ t: 'vote', id: poll.id, choice: [2] });
  await ana.next(isPoll((m) => m.ack && m.mine?.[0] === 2));
  await sleep(300);
  const last = [...bea.messages].reverse().find((m) => m.t === 'poll' && m.poll);
  assert.equal(last?.poll.open ?? true, true, 'still open for Bea');
});

test('the CSV of a deck nobody has connected to is not found', async (t) => {
  const { app, dirs } = await setup(t);
  await makeDeck(dirs.dataDir, 'quiet', { meta: { slidecast: 1, slides: {} } });
  const res = await app.inject({ method: 'GET', url: '/api/decks/quiet/contest.csv', headers: LOCAL });
  assert.equal(res.statusCode, 404);
});
