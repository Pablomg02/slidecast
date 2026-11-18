import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { onCleanup, tempDirs, makeDeck, listen, wsClient, openRooms } from './helpers.js';

// The shared pointer on the server (T6 of 0010): presenters' positions are
// relayed to every other screen of the deck, within limits, never stored.
const LOCAL = { host: 'localhost:4321', origin: 'http://localhost:4321' };
const PROXIED = { 'X-Forwarded-For': '203.0.113.50' };
const FROZEN = { slidecast: 1, frozen: true, pointer: true };

async function setup(t) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk', { meta: FROZEN });
  await makeDeck(dirs.dataDir, 'plain');
  const app = await buildServer(dirs);
  await openRooms(app, ['talk', 'plain']);
  await app.slidecast.auth.setPassword('presenter', null, 'presenter-pass1');
  const urls = await listen(app);
  const clients = [];
  const ws = (role, o = {}) => {
    const c = wsClient(`${urls.ws}/ws/${o.slug ?? 'talk'}?role=${role}`, { headers: PROXIED, ...o });
    clients.push(c);
    return c;
  };
  onCleanup(t, async () => {
    for (const c of clients) c.close();
    await app.close();
  });
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: LOCAL, payload: { scope: 'presenter', password: 'presenter-pass1' } });
    assert.equal(res.statusCode, 204);
    return `sc_session=${res.cookies.find((c) => c.name === 'sc_session').value}`;
  };
  // A presenter on a device of its own (a session), once it has the state.
  const presenter = async (cookie, o = {}) => {
    const c = ws('presenter', { cookie: cookie ?? await login(), ...o });
    await c.next((m) => m.t === 'state');
    return c;
  };
  const participant = async (o = {}) => {
    const c = ws('viewer', { join: true, ...o });
    await c.next((m) => m.t === 'you');
    return c;
  };
  const display = async (cookie) => {
    const c = ws('viewer', { cookie });
    await c.next((m) => m.t === 'state');
    return c;
  };
  return { app, ws, login, presenter, participant, display };
}

const ptrs = (c) => c.messages.filter((m) => m.t === 'ptr');
const settle = (ms = 150) => new Promise((r) => { setTimeout(r, ms); });
const isPtr = (pred = () => true) => (m) => m.t === 'ptr' && pred(m);

test('a move reaches the participants, the displays and the other presenters, not its sender', async (t) => {
  const { login, presenter, participant, display } = await setup(t);
  const cookie = await login();
  const p = await presenter(cookie);
  const other = await presenter();
  const projector = await display(cookie);
  const v = await participant();
  p.send({ t: 'ptr', x: 2500, y: 7500 });
  for (const c of [v, projector, other]) {
    const m = await c.next(isPtr());
    assert.deepEqual(m, { t: 'ptr', id: 0, x: 2500, y: 7500 });
    assert.deepEqual(Object.keys(m).sort(), ['id', 't', 'x', 'y'], 'no device id, session or name');
  }
  await settle();
  assert.deepEqual(ptrs(p), []);
});

test('each presenter device gets its own slot, shown in its own room row', async (t) => {
  const { login, presenter } = await setup(t);
  const a = await presenter(await login());
  const b = await presenter(await login());
  a.send({ t: 'ptr', on: true });
  const roomA = await a.next((m) => m.t === 'room' && m.presenters.some((d) => d.you && d.ptr === 0));
  assert.equal(roomA.presenters.length, 2);
  b.send({ t: 'ptr', x: 1, y: 2 });
  const roomB = await b.next((m) => m.t === 'room' && m.presenters.some((d) => d.you && d.ptr === 1));
  assert.ok(roomB.presenters.some((d) => !d.you && d.ptr === 0));
  assert.deepEqual(await a.next(isPtr()), { t: 'ptr', id: 1, x: 1, y: 2 });
});

test('pointer-off on a deck without the pointer; forbidden for the audience; bad values refused', async (t) => {
  const { login, presenter, participant, display } = await setup(t);
  const cookie = await login();
  const plain = await presenter(cookie, { slug: 'plain' });
  plain.send({ t: 'ptr', on: true });
  assert.equal((await plain.next((m) => m.t === 'error')).code, 'pointer-off');
  const v = await participant();
  v.send({ t: 'ptr', x: 1, y: 1 });
  assert.equal((await v.next((m) => m.t === 'error')).code, 'forbidden');
  const projector = await display(cookie);
  projector.send({ t: 'ptr', x: 1, y: 1 });
  assert.equal((await projector.next((m) => m.t === 'error')).code, 'forbidden');
  const p = await presenter(cookie);
  for (const bad of [{ x: -1, y: 0 }, { x: 0, y: 10001 }, { x: 1.5, y: 0 }, { x: '1', y: '2' }, { x: 1 }, {}, { on: 1 }, { off: 'yes' }]) {
    p.send({ t: 'ptr', ...bad });
    assert.equal((await p.next((m) => m.t === 'error')).code, 'bad-message', JSON.stringify(bad));
  }
  await settle();
  assert.deepEqual(ptrs(v), []);
});

test('at most 30 moves a second are relayed; none while the screen is blank', async (t) => {
  const { presenter, participant } = await setup(t);
  const p = await presenter();
  const v = await participant();
  for (let i = 0; i < 60; i++) p.send({ t: 'ptr', x: i, y: i });
  await settle(300);
  const got = ptrs(v);
  assert.ok(got.length <= 30, `${got.length} relayed`);
  assert.ok(got.length >= 25, `${got.length} relayed`);
  assert.deepEqual(got[0], { t: 'ptr', id: 0, x: 0, y: 0 });
  v.messages.length = 0;
  await settle(1000);
  p.send({ t: 'blank', on: true });
  await v.next((m) => m.t === 'state' && m.blank);
  p.send({ t: 'ptr', x: 5, y: 5 });
  await settle();
  assert.deepEqual(ptrs(v), []);
});

test('off is relayed once; closing a presenter hides its dot and frees its slot', async (t) => {
  const { presenter, participant } = await setup(t);
  const p = await presenter();
  const v = await participant();
  p.send({ t: 'ptr', off: true });
  await settle();
  assert.deepEqual(ptrs(v), [], 'nothing shown, nothing to hide');
  p.send({ t: 'ptr', x: 10, y: 20 });
  await v.next(isPtr((m) => m.x === 10));
  p.send({ t: 'ptr', off: true });
  assert.deepEqual(await v.next(isPtr()), { t: 'ptr', id: 0, off: true });
  p.send({ t: 'ptr', off: true });
  await settle();
  assert.deepEqual(ptrs(v), [], 'a repeated off sends nothing');
  p.send({ t: 'ptr', x: 30, y: 40 });
  await v.next(isPtr((m) => m.x === 30));
  p.close();
  assert.deepEqual(await v.next(isPtr()), { t: 'ptr', id: 0, off: true });
  const q = await presenter();
  q.send({ t: 'ptr', x: 1, y: 1 });
  assert.equal((await v.next(isPtr())).id, 0, 'the slot is free again');
});

test('a step change hides the dots: a later off sends nothing', async (t) => {
  const { presenter, participant } = await setup(t);
  const p = await presenter();
  const v = await participant();
  p.send({ t: 'meta', total: 5 });
  p.send({ t: 'ptr', x: 10, y: 20 });
  await v.next(isPtr());
  p.send({ t: 'step', delta: 1 });
  await v.next((m) => m.t === 'state' && m.index === 1);
  p.send({ t: 'ptr', off: true });
  await settle();
  assert.deepEqual(ptrs(v), []);
});

test('turning the pointer off clears every dot; the snapshot has the flag, never positions', async (t) => {
  const { app, presenter, participant } = await setup(t);
  const p = await presenter();
  const v = await participant();
  p.send({ t: 'ptr', x: 10, y: 20 });
  await v.next(isPtr());
  const states = v.messages.filter((m) => m.t === 'state');
  const patch = await app.inject({ method: 'PATCH', url: '/api/admin/decks/talk', headers: LOCAL, payload: { pointer: false } });
  assert.equal(patch.statusCode, 200);
  const state = await v.next((m) => m.t === 'state' && m.pointer === false);
  assert.deepEqual(await v.next(isPtr()), { t: 'ptr', clear: true });
  for (const s of [...states, state]) {
    assert.equal(typeof s.pointer, 'boolean');
    assert.equal(JSON.stringify(s).includes('"x"'), false);
  }
  p.send({ t: 'ptr', x: 1, y: 1 });
  assert.equal((await p.next((m) => m.t === 'error')).code, 'pointer-off');
});

test('a device keeps its slot while another of its windows stays; pending joins get nothing', async (t) => {
  const { ws, login, presenter, participant } = await setup(t);
  const cookie = await login();
  const a = await presenter(cookie);
  const b = await presenter(cookie); // a second window of the same device
  const v = await participant();
  const pending = ws('viewer'); // connected, never joined
  await pending.opened;
  a.send({ t: 'ptr', x: 10, y: 10 });
  assert.equal((await v.next(isPtr())).id, 0);
  b.send({ t: 'ptr', x: 20, y: 20 });
  assert.deepEqual(await v.next(isPtr()), { t: 'ptr', id: 0, x: 20, y: 20 }, 'same device, same colour');
  a.close(); // b moves the dot now: a's leaving hides nothing
  await settle(200);
  assert.deepEqual(ptrs(v), []);
  const other = await presenter();
  other.send({ t: 'ptr', x: 1, y: 1 });
  assert.equal((await v.next(isPtr())).id, 1, 'slot 0 still belongs to the device');
  await settle();
  assert.deepEqual(ptrs(pending), []);
});

test('a deck update hides the dots but keeps the colours; a pointer flip in deck.json applies', async (t) => {
  const { app, presenter, participant } = await setup(t);
  const a = await presenter();
  const b = await presenter();
  const v = await participant();
  a.send({ t: 'ptr', x: 1, y: 1 });
  await v.next(isPtr((m) => m.id === 0));
  b.send({ t: 'ptr', x: 2, y: 2 });
  await v.next(isPtr((m) => m.id === 1));
  app.slidecast.live.resetDeck('talk');
  assert.deepEqual(await v.next(isPtr()), { t: 'ptr', clear: true });
  b.send({ t: 'ptr', x: 3, y: 3 });
  assert.equal((await v.next(isPtr())).id, 1, 'B keeps its colour');
  // A new version without the pointer turns it off live.
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await writeFile(join(app.slidecast.decks.dirOf('talk'), 'deck.json'), JSON.stringify({ slidecast: 1, frozen: true }));
  app.slidecast.live.resetDeck('talk');
  await v.next((m) => m.t === 'state' && m.pointer === false);
});

test('a deck without the pointer gets no clear on a deck update', async (t) => {
  const { app, login, presenter, ws } = await setup(t);
  const p = await presenter(await login(), { slug: 'plain' });
  const v = ws('viewer', { slug: 'plain', join: true });
  await v.next((m) => m.t === 'you');
  app.slidecast.live.resetDeck('plain');
  await settle(200);
  assert.deepEqual([...ptrs(v), ...ptrs(p)], []);
});
