import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { cleanContest, contestOf, CONTEST_DEFAULTS } from '../src/contest.js';
import { cleanPoll, pollOf } from '../src/polls.js';
import { onCleanup, tempDirs, makeDeck, openRooms } from './helpers.js';

const LOCAL = { host: 'localhost:4321', origin: 'http://localhost:4321' };
const QUIZ = { question: 'Which planet is largest?', options: ['Mars', 'Jupiter', 'Venus'], correct: [1] };

async function server(t, meta = { slidecast: 1, slides: { quiz: { poll: QUIZ } } }) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk', { meta });
  const app = await buildServer({ ...dirs, graceMs: 200 });
  await openRooms(app, ['talk']);
  onCleanup(t, () => app.close());
  const onDisk = async () => JSON.parse(await readFile(join(dirs.dataDir, 'talk', 'deck.json'), 'utf8'));
  return { app, dirs, onDisk };
}

// ---- settings (D1–D3) --------------------------------------------------------------

test('contest settings: defaults, strict checks for the API, lenient reading of deck.json', () => {
  assert.deepEqual(cleanContest({}, { strict: true }).contest, { on: false, points: 1000, time: 30, speed: 50 });
  assert.deepEqual(cleanContest({ on: true, time: null, speed: 0 }, { strict: true }).contest,
    { on: true, points: 1000, time: null, speed: 0 });
  for (const bad of [{ points: 0 }, { points: 10_001 }, { points: 1.5 }, { time: 4 }, { time: 601 }, { time: '30' },
    { speed: -1 }, { speed: 101 }, { on: 'yes' }]) {
    assert.ok(cleanContest(bad, { strict: true }).error, JSON.stringify(bad));
  }
  assert.ok(cleanContest([], { strict: true }).error);
  assert.deepEqual(contestOf({ contest: { on: true, time: 3, points: 500 } }), { on: true, points: 500, time: 30, speed: 50 });
  assert.deepEqual(contestOf({}), CONTEST_DEFAULTS);
  assert.deepEqual(contestOf({ contest: 'on' }), CONTEST_DEFAULTS);
});

test('a poll keeps its contest fields when valid; strict refuses invalid ones, deck.json drops them', () => {
  const base = { question: 'Q?', options: ['a', 'b'] };
  assert.deepEqual(cleanPoll({ ...base, points: 2000, time: null, contest: false }, { strict: true }).poll,
    { ...base, multiple: false, points: 2000, time: null, contest: false });
  assert.deepEqual(cleanPoll({ ...base, time: 60, contest: true }, { strict: true }).poll, { ...base, multiple: false, time: 60 });
  for (const bad of [{ time: 3 }, { points: 0 }, { contest: 'no' }]) {
    assert.ok(cleanPoll({ ...base, ...bad }, { strict: true }).error, JSON.stringify(bad));
  }
  assert.deepEqual(pollOf({ poll: { ...base, time: 3, points: 300 } }), { ...base, multiple: false, points: 300 });
});

test('the admin API saves contest settings and serves them; a poll\'s contest fields left out are removed', async (t) => {
  const { app, onDisk } = await server(t);
  const patch = (payload) => app.inject({ method: 'PATCH', url: '/api/admin/decks/talk', headers: LOCAL, payload });
  let res = await patch({ contest: { on: true, time: null } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().contest, { on: true, points: 1000, time: null, speed: 50 });
  assert.deepEqual((await onDisk()).contest, { on: true, points: 1000, time: null, speed: 50 });
  res = await patch({ contest: { speed: 20 } });
  assert.deepEqual(res.json().contest, { on: true, points: 1000, time: null, speed: 20 }, 'the rest stays');
  assert.equal((await patch({ contest: { time: 2 } })).statusCode, 400);
  assert.equal((await patch({ contest: 'on' })).statusCode, 400);

  const rows = (await app.inject({ method: 'GET', url: '/api/admin/decks', headers: LOCAL })).json();
  assert.deepEqual(rows.decks.find((d) => d.slug === 'talk').contest, { on: true, points: 1000, time: null, speed: 20 });

  const deck = (await app.inject({ method: 'GET', url: '/api/decks/talk', headers: LOCAL })).json();
  assert.equal(deck.contest, true);
  assert.deepEqual(deck.contestConfig, { on: true, points: 1000, time: null, speed: 20 });
  const outsider = (await app.inject({ method: 'GET', url: '/api/decks/talk', headers: { ...LOCAL, 'X-Forwarded-For': '203.0.113.50' } })).json();
  assert.equal(outsider.contest, true);
  assert.equal('contestConfig' in outsider, false);

  const put = (poll) => app.inject({ method: 'PUT', url: '/api/admin/decks/talk/slides/quiz', headers: LOCAL, payload: { notes: '', steps: {}, poll } });
  res = await put({ ...QUIZ, points: 2000, time: 60, contest: false });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((await onDisk()).slides.quiz.poll, { ...QUIZ, multiple: false, points: 2000, time: 60, contest: false });
  res = await put({ ...QUIZ });
  assert.deepEqual((await onDisk()).slides.quiz.poll, { ...QUIZ, multiple: false });
  assert.equal((await put({ ...QUIZ, time: 3 })).statusCode, 400);
});

test('a deck.json written by hand with a bad contest field keeps the rest', async (t) => {
  const { app } = await server(t, { slidecast: 1, contest: { on: true, speed: 'fast' }, slides: { quiz: { poll: { ...QUIZ, time: 1 } } } });
  const deck = (await app.inject({ method: 'GET', url: '/api/decks/talk', headers: LOCAL })).json();
  assert.deepEqual(deck.contestConfig, { on: true, points: 1000, time: 30, speed: 50 });
});

// ---- timing and scoring (D4–D9, D17, D18) -------------------------------------------

import { createPolls } from '../src/polls.js';
import { rankingOf, pointsFor } from '../src/contest.js';

// A room's polls on a clock the test moves by hand.
function fakePolls(settings = {}) {
  const clock = { ms: 0 };
  const contest = { on: true, points: 1000, time: 20, speed: 50, ...settings };
  const polls = createPolls({ now: () => clock.ms, contest: () => contest });
  const at = (ms) => { clock.ms = ms; };
  const vote = (voter, slide, choice) => polls.vote(voter, polls.get(slide).id, choice, clock.ms);
  const totals = () => Object.fromEntries(polls.scores().voters.map((v) => [v.voter, v.points]));
  return { polls, clock, contest, at, vote, totals };
}
const FIVE = { question: 'Which are right?', options: ['a', 'b', 'c', 'd', 'e'], multiple: true, correct: [0, 2] };
const ONE = { question: 'Which one?', options: ['a', 'b', 'c'], multiple: false, correct: [1] };

test('points: right part over right answers minus wrong part, slowed by the time taken, never below 0', () => {
  const { polls, at, vote, totals } = fakePolls();
  polls.show('q', FIVE);
  at(0); assert.equal(vote('v2', 'q', [0, 1]), null);
  at(5000); assert.equal(vote('v3', 'q', [1, 3]), null);
  at(10_000); assert.equal(vote('v1', 'q', [0, 2]), null);
  at(12_000); polls.setOpen('q', false, true); // closed early: still measured against the 20 s countdown
  assert.deepEqual(totals(), { v1: 750, v2: 167, v3: 0 });

  const one = fakePolls();
  one.polls.show('s', ONE);
  one.at(20_000);
  assert.equal(one.vote('right', 's', [1]), null);
  assert.equal(one.vote('wrong', 's', [0]), null);
  one.polls.setOpen('s', false, true);
  assert.deepEqual(one.totals(), { right: 500, wrong: 0 });
  one.contest.speed = 0; // a change of settings scores everything again (D24)
  assert.deepEqual(one.totals(), { right: 1000, wrong: 0 });
});

test('without a countdown, speed is measured against how long answers were open', () => {
  const { polls, at, vote, totals } = fakePolls({ time: null });
  polls.show('s', ONE);
  at(4000); vote('a', 's', [1]);
  at(8000); polls.setOpen('s', false, true);
  assert.deepEqual(totals(), { a: 750 });
  assert.equal(polls.deadlines().size, 0);
});

test('reopening resumes the open clock; a used-up countdown cannot be reopened', () => {
  const { polls, at, vote } = fakePolls();
  polls.show('s', ONE);
  at(6000); polls.setOpen('s', false);
  at(100_000); assert.equal(polls.setOpen('s', true), true);
  at(102_000); vote('a', 's', [1]);
  assert.equal(polls.get('s').stamps.get('a'), 8000);
  assert.equal(polls.deadlines().get('s'), 20_000 + 1000 - 8000);
  at(114_000); polls.setOpen('s', false); // clock: 6 s + 14 s = 20 s
  assert.equal(polls.setOpen('s', true), 'time-up');
  assert.equal(polls.forPresenters().runs[0].timeUp, true);
});

test('a countdown takes answers 1 s late, closes with the results secret, and never pays more than P', () => {
  const { polls, at, vote, totals } = fakePolls();
  polls.show('s', ONE);
  at(20_900); assert.equal(vote('late', 's', [1]), null);
  at(21_100); assert.equal(vote('later', 's', [1]), 'poll-closed');
  assert.equal(polls.expire('s'), true);
  assert.deepEqual([polls.get('s').open, polls.get('s').revealed], [false, false]);
  polls.setRevealed('s', true);
  assert.deepEqual(totals(), { late: 500 });
  const p = pointsFor({ choice: [1], at: -50 }, { correct: [1], multiple: false, options: 3, points: 1000, T: 20_000 }, { speed: 50 });
  assert.equal(p.points, 1000);
  assert.equal(pointsFor({ choice: [1], at: 99_999 }, { correct: [1], multiple: false, options: 3, points: 1000, T: 20_000 }, { speed: 50 }).t, 20_000);
});

test('a poll counts once closed with its results shown; opinion polls and excluded ones never do', () => {
  const { polls, at, vote, totals } = fakePolls();
  polls.show('s', ONE);
  vote('a', 's', [1]);
  at(1000); polls.setOpen('s', false, false);
  assert.deepEqual(totals(), {}, 'closed, results secret: not yet');
  assert.deepEqual(polls.unscored(), ['s']);
  polls.setRevealed('s', true);
  assert.equal(totals().a, 1000);
  assert.deepEqual(polls.unscored(), []);
  polls.setRevealed('s', false);
  assert.equal(totals().a, 1000, 'hiding the results again keeps the points');
  assert.equal(polls.setOpen('s', true), true);
  assert.deepEqual(totals(), {}, 'reopened: answers may change');
  polls.setOpen('s', false, true);
  assert.equal(totals().a, 1000);

  polls.show('opinion', { question: 'Like it?', options: ['yes', 'no'], multiple: false });
  vote('a', 'opinion', [0]);
  polls.setOpen('opinion', false, true);
  polls.show('warmup', { ...ONE, contest: false });
  vote('a', 'warmup', [1]);
  polls.setOpen('warmup', false, true);
  assert.deepEqual(polls.scores().runs.map((r) => r.slide), ['s']);
  assert.equal(polls.forPresenters().runs.find((r) => r.slide === 'warmup').left, null, 'no countdown for a poll that does not count');
});

test('a poll\'s own points and countdown override the deck\'s', () => {
  const { polls, at, vote, totals } = fakePolls();
  polls.show('s', { ...ONE, points: 2000, time: 60 });
  at(30_000); vote('a', 's', [1]);
  polls.setOpen('s', false, true);
  assert.deepEqual(totals(), { a: 1500 });
  polls.show('n', { ...ONE, question: 'No clock', time: null });
  assert.equal(polls.deadlines().has('n'), false);
});

test('the ranking shares places on ties, orders ties by name, puts unnamed last; runs keep their order', () => {
  const people = { a: { n: 1, name: 'Bea' }, b: { n: 2, name: 'Ana' }, c: { n: 3, name: null }, d: { n: 4, name: 'Zoe' } };
  const rows = rankingOf([{ voter: 'a', points: 500 }, { voter: 'b', points: 500 }, { voter: 'c', points: 900 }, { voter: 'd', points: 100 }, { voter: 'e', points: 500 }],
    (id) => people[id] ?? { n: 5, name: null });
  assert.deepEqual(rows.map((r) => [r.pos, r.name ?? `#${r.n}`]), [[1, '#3'], [2, 'Ana'], [2, 'Bea'], [2, '#5'], [5, 'Zoe']]);

  const { polls, vote } = fakePolls();
  polls.show('first', ONE);
  polls.show('second', { ...ONE, question: 'Second?' });
  vote('a', 'second', [1]);
  polls.setOpen('second', false, true);
  polls.show('first', ONE);
  vote('a', 'first', [1]);
  polls.setOpen('first', false, true);
  const { runs } = polls.scores();
  assert.deepEqual(runs.map((r) => r.slide), ['first', 'second'], 'creation order');
  assert.ok(runs[0].scoredSeq > runs[1].scoredSeq, 'the first counted last');
});

test('runs that count are never dropped by the 100-run cap', () => {
  const { polls, vote } = fakePolls();
  polls.show('kept', ONE);
  vote('a', 'kept', [1]);
  polls.setOpen('kept', false, true);
  for (let i = 0; i < 120; i++) polls.show(`s${i}`, { ...ONE, question: `Q${i}?` });
  assert.ok(polls.get('kept'));
  assert.equal(polls.size, 100);
});

test('an answer received in time counts even if it is handled after the deadline (it waited in the queue)', () => {
  const { polls, at } = fakePolls();
  polls.show('s', ONE);
  at(30_000); // handled now, received at 19 s
  assert.equal(polls.vote('a', polls.get('s').id, [1], 19_000), null);
  assert.equal(polls.get('s').stamps.get('a'), 19_000);
});
