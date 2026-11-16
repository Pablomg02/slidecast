import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { cleanPoll, pollOf, createPolls } from '../src/polls.js';
import { summarize } from '../src/notes.js';
import { onCleanup, tempDirs, makeDeck, listen, wsClient, openRooms } from './helpers.js';

const LOCAL = { host: 'localhost:4321', origin: 'http://localhost:4321' };
const PROXIED = { 'X-Forwarded-For': '203.0.113.50' };

const QUIZ = { question: 'Which planet is largest?', options: ['Mars', 'Jupiter', 'Venus'] };
const MULTI = { question: 'Which are gas giants?', options: ['Jupiter', 'Earth', 'Saturn', 'Neptune'], multiple: true };

async function setup(t, { slides } = {}) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk', {
    meta: slides ?? { slidecast: 1, slides: { quiz: { notes: 'n', poll: QUIZ }, gas: { poll: MULTI }, half: { poll: { question: 'Only one?', options: ['a'] } } } },
  });
  const app = await buildServer({ ...dirs, graceMs: 200 });
  await openRooms(app, ['talk']);
  const urls = await listen(app);
  const clients = [];
  const ws = (role, o = {}) => {
    const c = wsClient(`${urls.ws}/ws/talk?role=${role}`, o);
    clients.push(c);
    return c;
  };
  // Loopback with no password: local direct, so it may present. Ready once
  // its first polls message arrived.
  const presenter = async () => {
    const c = ws('presenter');
    await c.next(isPolls());
    return c;
  };
  // A viewer with presenter rights: the projector (a display).
  const display = () => ws('viewer');
  // A participant: through a proxy, joining as a new one or with a token.
  const viewer = (token = true) => ws('viewer', { join: token, headers: PROXIED });
  onCleanup(t, async () => {
    for (const c of clients) c.close();
    await app.close();
  });
  return { app, dirs, urls, presenter, display, viewer, ctx: app.slidecast };
}

const isPolls = (pred = () => true) => (m) => m.t === 'polls' && pred(m);
const isPoll = (pred = () => true) => (m) => m.t === 'poll' && pred(m);
const isError = (code) => (m) => m.t === 'error' && m.code === code;
const runOf = (m, slide) => m.runs.find((r) => r.slide === slide);

// ---- definitions ---------------------------------------------------------------

test('a poll is cleaned: answers trimmed, empty ones dropped, limits enforced', () => {
  assert.deepEqual(cleanPoll({ question: '  Best\tlanguage?\u0007 ', options: [' JS ', '', 'Python', '  '] }),
    { poll: { question: 'Best language?', options: ['JS', 'Python'], multiple: false } });
  assert.deepEqual(cleanPoll(null), { poll: null });
  assert.deepEqual(cleanPoll({ question: ' ', options: ['', ' '] }), { poll: null }, 'nothing written: no poll');
  assert.deepEqual(cleanPoll({ question: 'Half', options: [] }).poll, { question: 'Half', options: [], multiple: false }, 'half written is kept');
  assert.equal([...cleanPoll({ question: 'q'.repeat(400), options: [] }).poll.question].length, 300);
  assert.equal([...cleanPoll({ question: 'q', options: ['o'.repeat(200)] }).poll.options[0]].length, 150);
  for (const bad of [[], 'text', { question: 3 }, { options: 'a' }, { options: [1] }, { multiple: 'yes' },
    { options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, { question: 'x'.repeat(2001) }]) {
    assert.ok(cleanPoll(bad).error, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(cleanPoll({ options: Array.from({ length: 10 }, (_, i) => `o${i}`) }).poll.options.length, 10);
});

test('only a poll with a question and two answers can be launched', () => {
  assert.deepEqual(pollOf({ poll: QUIZ }), { ...QUIZ, multiple: false });
  assert.equal(pollOf({ poll: { question: 'q', options: ['a'] } }), null);
  assert.equal(pollOf({ poll: { question: '', options: ['a', 'b'] } }), null);
  assert.equal(pollOf({ poll: { question: 'q', options: ['a', 'b'], multiple: 1 } }), null, 'invalid shape');
  assert.equal(pollOf({ notes: 'x' }), null);
  assert.equal(pollOf(null), null);
});

test('runs: answers counted once per voter, changed, refused when closed, forgotten', () => {
  const polls = createPolls();
  assert.equal(polls.show('quiz', null), false, 'nothing to show');
  assert.equal(polls.show('quiz', { ...QUIZ, multiple: false }), true);
  const { id } = polls.shown;
  assert.equal(polls.vote('p1', id, [1]), null);
  assert.equal(polls.vote('p2', id, [1]), null);
  assert.equal(polls.vote('p1', id, [0]), null, 'a change replaces the answer');
  assert.deepEqual(polls.shown.counts, [1, 1, 0]);
  assert.equal(polls.vote('p3', id, [0, 1]), 'bad-message', 'one answer only');
  assert.equal(polls.vote('p3', id, [3]), 'bad-message');
  assert.equal(polls.vote('p3', id, []), 'bad-message');
  assert.equal(polls.vote('p3', id, ['0']), 'bad-message');
  assert.equal(polls.vote('p3', 'other', [0]), 'poll-gone');
  polls.setOpen('quiz', false);
  assert.equal(polls.vote('p3', id, [2]), 'poll-closed');
  assert.deepEqual(polls.forParticipant('p1').poll.results, { counts: [1, 1, 0], voters: 2 });
  assert.equal(polls.forget('p2'), true);
  assert.deepEqual(polls.shown.counts, [1, 0, 0]);
  assert.equal(polls.forget('nobody'), false);

  polls.show('gas', { ...MULTI });
  assert.equal(polls.vote('p1', id, [0]), 'poll-gone', 'only the shown poll takes answers');
  const gas = polls.shown.id;
  assert.equal(polls.vote('p1', gas, [3, 0]), null);
  assert.equal(polls.vote('p1', gas, [0, 0]), 'bad-message', 'no repeats');
  assert.deepEqual(polls.forParticipant('p1').mine, [0, 3]);
  assert.deepEqual(polls.forPresenters().runs.map((r) => [r.slide, r.voters]), [['quiz', 1], ['gas', 1]]);
});

test('a run takes a new text only while nobody has answered it', () => {
  const polls = createPolls();
  polls.show('quiz', { ...QUIZ, multiple: false });
  const first = polls.shown.id;
  assert.equal(polls.refresh({ quiz: { poll: { ...QUIZ, question: 'Largest planet?' } } }), true);
  assert.notEqual(polls.shown.id, first, 'a new text is a new run');
  assert.equal(polls.shown.question, 'Largest planet?');
  polls.vote('p1', polls.shown.id, [1]);
  assert.equal(polls.refresh({ quiz: { poll: { ...QUIZ, question: 'Changed again' } } }), false);
  polls.hide();
  polls.show('quiz', { ...QUIZ, question: 'Changed again', multiple: false });
  assert.equal(polls.shown.question, 'Largest planet?', 'answered: the snapshot stays');
  assert.equal(polls.reset('quiz'), true, 'reset: as if never launched');
  assert.equal(polls.shown, null);
  assert.equal(polls.size, 0);
  assert.equal(polls.reset('quiz'), false, 'nothing left to reset');
  polls.show('quiz', { ...QUIZ, question: 'Changed again', multiple: false });
  assert.equal(polls.shown.question, 'Changed again', 'launched again: the current text');
  assert.equal(polls.shown.ballots.size, 0);
  assert.equal(polls.shown.open, true);
});

test('a room keeps at most 100 runs, dropping the one shown longest ago', () => {
  const polls = createPolls();
  for (let i = 0; i < 105; i++) polls.show(`s${i}`, { question: 'q', options: ['a', 'b'], multiple: false });
  assert.equal(polls.size, 100);
  assert.equal(polls.get('s0'), null);
  assert.ok(polls.get('s104'));
  assert.equal(polls.shown.slide, 's104');
});

test('a slide removed by an update with only a poll counts as losing its notes', () => {
  const steps = [{ slide: 'a', step: 0 }];
  assert.deepEqual(summarize({ a: { notes: 'x' }, quiz: { poll: QUIZ } }, steps).removedSlides, ['quiz']);
});

// ---- editor API ------------------------------------------------------------------

test('the notes API stores, cleans and removes a slide\'s poll', async (t) => {
  const { app, dirs } = await setup(t);
  const put = (payload) => app.inject({ method: 'PUT', url: '/api/admin/decks/talk/slides/quiz', headers: LOCAL, payload });
  const onDisk = async () => JSON.parse(await readFile(join(dirs.dataDir, 'talk', 'deck.json'), 'utf8')).slides.quiz;

  // A field of the poll the editor does not know is kept.
  const meta = JSON.parse(await readFile(join(dirs.dataDir, 'talk', 'deck.json'), 'utf8'));
  meta.slides.quiz.poll.mine = 'kept';
  await writeFile(join(dirs.dataDir, 'talk', 'deck.json'), JSON.stringify(meta));

  let res = await put({ notes: 'n2', steps: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((await onDisk()).poll, { ...QUIZ, mine: 'kept' }, 'no poll field: kept');
  res = await put({ notes: 'n2', steps: {}, poll: { question: ' New? ', options: ['Yes', '', 'No'], multiple: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().slide.poll, { question: 'New?', options: ['Yes', 'No'], multiple: true, mine: 'kept' });
  for (const poll of [{ options: [1, 2] }, 'x', { multiple: 'no' }, { options: Array.from({ length: 11 }, () => 'o') }]) {
    assert.equal((await put({ notes: 'n2', steps: {}, poll })).statusCode, 400, JSON.stringify(poll));
  }
  res = await put({ notes: 'n2', steps: {}, poll: null });
  assert.equal(res.statusCode, 200);
  assert.equal('poll' in (await onDisk()), false);
  assert.equal((await onDisk()).notes, 'n2');
});

// ---- live ------------------------------------------------------------------------

test('the presenter shows a poll; participants answer; presenters and displays see counts only', async (t) => {
  const { presenter, display, viewer } = await setup(t);
  const p = await presenter();
  const proj = display();
  await proj.next(isPolls());
  const v1 = viewer();
  const v2 = viewer();
  assert.equal((await v1.next(isPoll())).poll, null);
  await v2.next(isPoll());

  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const shown = await p.next(isPolls((m) => m.shown === 'quiz'));
  assert.deepEqual(runOf(shown, 'quiz'), {
    slide: 'quiz', id: runOf(shown, 'quiz').id, question: QUIZ.question, options: QUIZ.options, multiple: false, open: true, counts: [0, 0, 0], voters: 0,
  });
  await proj.next(isPolls((m) => m.shown === 'quiz'));
  const { poll } = await v1.next(isPoll((m) => m.poll));
  assert.deepEqual(poll, { id: poll.id, question: QUIZ.question, options: QUIZ.options, multiple: false, open: true, results: null });

  v1.send({ t: 'vote', id: poll.id, choice: [1] });
  assert.deepEqual((await v1.next(isPoll((m) => m.mine))).mine, [1]);
  v2.send({ t: 'vote', id: poll.id, choice: [1] });
  await v2.next(isPoll((m) => m.mine));
  v2.send({ t: 'vote', id: poll.id, choice: [2] });
  await v2.next(isPoll((m) => m.mine?.[0] === 2));
  const counted = await p.next(isPolls((m) => runOf(m, 'quiz')?.voters === 2 && runOf(m, 'quiz').counts[2] === 1));
  assert.deepEqual(runOf(counted, 'quiz').counts, [0, 1, 1]);
  // Anonymous: nothing in the presenters' message says who answered what.
  assert.equal(JSON.stringify(counted).includes('"mine"'), false);
  assert.deepEqual(Object.keys(runOf(counted, 'quiz')).sort(), ['counts', 'id', 'multiple', 'open', 'options', 'question', 'slide', 'voters']);
  await proj.next(isPolls((m) => runOf(m, 'quiz')?.voters === 2 && runOf(m, 'quiz').counts[2] === 1));
  // Participants never get the results while answers are open.
  assert.ok(v1.messages.filter((m) => m.t === 'poll').every((m) => m.poll === null || m.poll.results === null));
});

test('closing answers refuses new ones and shows participants the results; reopening takes them again', async (t) => {
  const { presenter, viewer } = await setup(t);
  const p = await presenter();
  const v = viewer();
  await v.next(isPoll());
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  v.send({ t: 'vote', id: poll.id, choice: [0] });
  await v.next(isPoll((m) => m.mine));

  p.send({ t: 'poll', action: 'close', slide: 'quiz' });
  const closed = await v.next(isPoll((m) => m.poll && !m.poll.open));
  assert.deepEqual(closed.poll.results, { counts: [1, 0, 0], voters: 1 });
  assert.deepEqual(closed.mine, [0]);
  v.send({ t: 'vote', id: poll.id, choice: [2] });
  const err = await v.next(isError('poll-closed'));
  assert.equal(err.about, 'poll');

  p.send({ t: 'poll', action: 'open', slide: 'quiz' });
  const reopened = await v.next(isPoll((m) => m.poll?.open));
  assert.equal(reopened.poll.results, null);
  assert.equal(reopened.poll.id, poll.id, 'the same run');
  v.send({ t: 'vote', id: poll.id, choice: [2] });
  assert.deepEqual((await v.next(isPoll((m) => m.mine?.[0] === 2))).mine, [2]);
});

test('a hidden poll keeps its answers; showing another hides it; showing it again brings it back as it was', async (t) => {
  const { presenter, viewer } = await setup(t);
  const p = await presenter();
  const v = viewer();
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  v.send({ t: 'vote', id: poll.id, choice: [1] });
  await v.next(isPoll((m) => m.mine));
  p.send({ t: 'poll', action: 'close', slide: 'quiz' });
  p.send({ t: 'poll', action: 'hide' });
  await v.next(isPoll((m) => m.poll === null));

  p.send({ t: 'poll', action: 'show', slide: 'gas' });
  const gas = await v.next(isPoll((m) => m.poll?.multiple));
  assert.equal(gas.mine, null);
  v.send({ t: 'vote', id: gas.poll.id, choice: [0, 2, 3] });
  assert.deepEqual((await v.next(isPoll((m) => m.poll?.id === gas.poll.id && m.mine))).mine, [0, 2, 3]);
  const both = await p.next(isPolls((m) => m.shown === 'gas' && runOf(m, 'gas')?.voters === 1));
  assert.equal(runOf(both, 'quiz').voters, 1, 'the hidden one kept its answer');

  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const back = await v.next(isPoll((m) => m.poll?.id === poll.id));
  assert.equal(back.poll.open, false, 'as it was: answers closed');
  assert.deepEqual(back.mine, [1]);
  assert.deepEqual(back.poll.results, { counts: [0, 1, 0], voters: 1 });
});

test('reset takes the poll off the screens with its answers, as if never launched; incomplete or unknown polls cannot be shown', async (t) => {
  const { presenter, viewer } = await setup(t);
  const p = await presenter();
  const v = viewer();
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  v.send({ t: 'vote', id: poll.id, choice: [1] });
  await v.next(isPoll((m) => m.mine));
  p.send({ t: 'poll', action: 'close', slide: 'quiz' });
  p.send({ t: 'poll', action: 'reset', slide: 'quiz' });
  const gone = await v.next(isPoll((m) => m.poll === null));
  assert.equal(gone.mine, null);
  const none = await p.next(isPolls((m) => !runOf(m, 'quiz')));
  assert.equal(none.shown, null);
  v.send({ t: 'vote', id: poll.id, choice: [1] });
  await v.next(isError('poll-gone'));
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const fresh = await v.next(isPoll((m) => m.poll && m.poll.id !== poll.id));
  assert.equal(fresh.mine, null);
  assert.equal(fresh.poll.open, true);
  assert.deepEqual(runOf(await p.next(isPolls((m) => runOf(m, 'quiz')?.id === fresh.poll.id)), 'quiz').counts, [0, 0, 0]);

  for (const slide of ['half', 'nope', '__proto__']) {
    p.send({ t: 'poll', action: 'show', slide });
    await p.next(isError('no-poll'));
  }
  for (const bad of [{ t: 'poll', action: 'show' }, { t: 'poll', action: 'explode', slide: 'quiz' }, { t: 'poll', action: 'show', slide: 'a\nb' }]) {
    p.send(bad);
    await p.next(isError('bad-message'));
  }
});

test('only presenters control polls; participants answer only the shown poll, at a limited pace', async (t) => {
  const { presenter, display, viewer } = await setup(t);
  const p = await presenter();
  const proj = display();
  const v = viewer();
  await v.next(isPoll());
  await proj.next(isPolls());
  v.send({ t: 'poll', action: 'show', slide: 'quiz' });
  await v.next(isError('forbidden'));
  proj.send({ t: 'poll', action: 'show', slide: 'quiz' });
  await proj.next(isError('forbidden'));
  p.send({ t: 'vote', id: 'x', choice: [0] });
  await p.next(isError('bad-message'));

  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  for (let i = 0; i < 10; i++) v.send({ t: 'vote', id: poll.id, choice: [i % 3] });
  v.send({ t: 'vote', id: poll.id, choice: [0] });
  const slow = await v.next(isError('slow-down'));
  assert.equal(slow.about, 'poll');
  assert.ok(slow.wait > 0);
  const last = (await p.next(isPolls((m) => runOf(m, 'quiz')?.voters === 1 && runOf(m, 'quiz').counts[0] === 1)));
  assert.deepEqual(runOf(last, 'quiz').counts, [1, 0, 0], 'the 10th answer counts, once');
});

test('a participant who reconnects gets its answer back; a removed one takes it away', async (t) => {
  const { presenter, viewer } = await setup(t);
  const p = await presenter();
  const v = viewer();
  const { token } = await v.next((m) => m.t === 'you');
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  v.send({ t: 'vote', id: poll.id, choice: [2] });
  await v.next(isPoll((m) => m.mine));
  v.close();

  const again = viewer(token);
  const back = await again.next(isPoll((m) => m.poll));
  assert.deepEqual(back.mine, [2]);
  await p.next(isPolls((m) => runOf(m, 'quiz')?.voters === 1));

  const room = await p.next((m) => m.t === 'room' && m.people.length === 1 && m.people[0].online);
  p.send({ t: 'kick', id: room.people[0].id });
  await again.closed;
  const after = await p.next(isPolls((m) => runOf(m, 'quiz')?.voters === 0));
  assert.deepEqual(runOf(after, 'quiz').counts, [0, 0, 0]);
});

test('closing the room forgets every poll', async (t) => {
  const { app, presenter, viewer } = await setup(t);
  const p = await presenter();
  const v = viewer();
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  v.send({ t: 'vote', id: poll.id, choice: [0] });
  await v.next(isPoll((m) => m.mine));
  await p.next(isPolls((m) => runOf(m, 'quiz')?.voters === 1));
  const patch = (open) => app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload: { open } });
  await patch(false);
  await v.next((m) => m.t === 'wait' && m.reason === 'closed');
  await p.next(isPolls((m) => m.shown === null && m.runs.length === 0));
  await patch(true);
  const fresh = viewer();
  assert.equal((await fresh.next(isPoll())).poll, null);
});

test('a poll edited before anyone answers it shows its new text at once', async (t) => {
  const { app, presenter, viewer } = await setup(t);
  const p = await presenter();
  const v = viewer();
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  const res = await app.inject({
    method: 'PUT', url: '/api/admin/decks/talk/slides/quiz', headers: LOCAL,
    payload: { notes: 'n', steps: {}, poll: { question: 'Which planet is the largest?', options: ['Mars', 'Jupiter'] } },
  });
  assert.equal(res.statusCode, 200);
  const edited = await v.next(isPoll((m) => m.poll && m.poll.id !== poll.id));
  assert.equal(edited.poll.question, 'Which planet is the largest?');
  assert.deepEqual(edited.poll.options, ['Mars', 'Jupiter']);
  await p.next(isPolls((m) => runOf(m, 'quiz')?.question === 'Which planet is the largest?'));
});

// ---- races and rights (review of 0006) -------------------------------------------

// Makes the next deck.json reads take `ms` longer, as on a slow disk.
function slowMeta(ctx, ms) {
  const read = ctx.decks.readMeta;
  ctx.decks.readMeta = async (...a) => {
    await new Promise((r) => setTimeout(r, ms));
    return read(...a);
  };
  return () => { ctx.decks.readMeta = read; };
}

test('a show still reading deck.json when the room closes is dropped', async (t) => {
  const { app, ctx, presenter, viewer } = await setup(t);
  const p = await presenter();
  const restore = slowMeta(ctx, 150);
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  await app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload: { open: false } });
  await new Promise((r) => setTimeout(r, 300));
  restore();
  assert.equal(ctx.live.getState('talk') !== null, true);
  await app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload: { open: true } });
  const v = viewer();
  assert.equal((await v.next(isPoll())).poll, null, 'nothing survives the close');
  assert.ok(!p.messages.some((m) => m.t === 'polls' && m.shown === 'quiz'));
});

test('an answer sent after "close answers" waits behind it and is refused', async (t) => {
  const { ctx, presenter, viewer } = await setup(t);
  const p = await presenter();
  const v = viewer();
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  const restore = slowMeta(ctx, 150);
  p.send({ t: 'poll', action: 'show', slide: 'half' }); // a slow command first: half written, nothing happens
  p.send({ t: 'poll', action: 'close', slide: 'quiz' });
  await new Promise((r) => setTimeout(r, 30));
  v.send({ t: 'vote', id: poll.id, choice: [1] });
  await v.next(isError('poll-closed'));
  restore();
  const ack = v.messages.find((m) => m.t === 'poll' && m.ack) ?? await v.next(isPoll((m) => m.ack));
  assert.equal(ack.mine, null);
});

test('the answer of a removed participant leaves the results participants see when answers are closed', async (t) => {
  const { presenter, viewer } = await setup(t);
  const p = await presenter();
  const v1 = viewer();
  const v2 = viewer();
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v1.next(isPoll((m) => m.poll));
  await v2.next(isPoll((m) => m.poll));
  v1.send({ t: 'vote', id: poll.id, choice: [0] });
  v2.send({ t: 'vote', id: poll.id, choice: [1] });
  await v1.next(isPoll((m) => m.ack && m.mine));
  await v2.next(isPoll((m) => m.ack && m.mine));
  p.send({ t: 'poll', action: 'close', slide: 'quiz' });
  assert.equal((await v1.next(isPoll((m) => m.poll && !m.poll.open))).poll.results.voters, 2);
  const room = await p.next((m) => m.t === 'room' && m.people.length === 2);
  const n2 = (await v2.next((m) => m.t === 'you')).n;
  p.send({ t: 'kick', id: room.people.find((x) => x.n === n2).id });
  const after = await v1.next(isPoll((m) => m.poll?.results?.voters === 1));
  assert.deepEqual(after.poll.results.counts, [1, 0, 0]);
});

test('a projector whose session ended stops getting live counts', async (t) => {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk', { meta: { slidecast: 1, slides: { quiz: { poll: QUIZ } } } });
  const app = await buildServer(dirs);
  await openRooms(app, ['talk']);
  await app.slidecast.auth.setPassword('presenter', null, 'presenter-pass1');
  const urls = await listen(app);
  const REMOTE = { host: urls.host, origin: urls.http, 'X-Forwarded-For': '203.0.113.9' };
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: REMOTE, payload: { scope: 'presenter', password: 'presenter-pass1' } });
  const cookie = `sc_session=${login.cookies.find((c) => c.name === 'sc_session').value}`;
  const proj = wsClient(`${urls.ws}/ws/talk?role=viewer`, { cookie, headers: { 'X-Forwarded-For': '203.0.113.9' } });
  const p = wsClient(`${urls.ws}/ws/talk?role=presenter`);
  const v = wsClient(`${urls.ws}/ws/talk?role=viewer`, { join: true, headers: PROXIED });
  onCleanup(t, async () => {
    for (const c of [proj, p, v]) c.close();
    await app.close();
  });
  await proj.next(isPolls());
  await p.next(isPolls());
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  const { poll } = await v.next(isPoll((m) => m.poll));
  await proj.next(isPolls((m) => m.shown === 'quiz'));
  await app.inject({ method: 'POST', url: '/api/logout', headers: { ...REMOTE, cookie } });
  v.send({ t: 'vote', id: poll.id, choice: [2] });
  const closed = await proj.closed;
  assert.equal(closed.code, 4401);
  assert.ok(!proj.messages.some((m) => m.t === 'polls' && m.runs.some((r) => r.voters > 0)), 'no counts after the session ended');
});

test('an unanswered run whose poll was deleted from deck.json is not shown again', async (t) => {
  const { app, presenter } = await setup(t);
  const p = await presenter();
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  await p.next(isPolls((m) => m.shown === 'quiz'));
  p.send({ t: 'poll', action: 'hide' });
  await p.next(isPolls((m) => m.shown === null));
  const put = await app.inject({ method: 'PUT', url: '/api/admin/decks/talk/slides/quiz', headers: LOCAL, payload: { notes: 'n', steps: {}, poll: null } });
  assert.equal(put.statusCode, 200);
  // Not on the screens and never answered: it goes with its poll.
  await p.next(isPolls((m) => m.runs.length === 0));
  p.send({ t: 'poll', action: 'show', slide: 'quiz' });
  await p.next(isError('no-poll'));
});
