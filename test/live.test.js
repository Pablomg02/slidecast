import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { onCleanup, tempDirs, makeDeck, listen, wsClient } from './helpers.js';

async function setup(t, dirs) {
  dirs ??= await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk', { meta: { syncdeck: 1, viewerNav: 'follow', slides: { a: { notes: 'n' } } } });
  const app = await buildServer(dirs);
  const urls = await listen(app);
  const clients = [];
  const connect = (role, opts) => {
    const c = wsClient(`${urls.ws}/ws/talk?role=${role}`, opts);
    clients.push(c);
    return c;
  };
  onCleanup(t, async () => {
    for (const c of clients) c.close();
    await app.close();
  });
  return { app, urls, connect, dirs };
}

const isState = (pred = () => true) => (m) => m.t === 'state' && pred(m);

test('presenter step reaches viewer and presenter', async (t) => {
  const { connect } = await setup(t);
  const viewer = connect('viewer');
  const first = await viewer.next(isState());
  assert.equal(first.index, 0);
  assert.equal(first.viewerNav, 'follow');
  const presenter = connect('presenter'); // loopback, no password: local direct
  await presenter.next(isState((m) => m.presenters === 1));
  const notes = await presenter.next((m) => m.t === 'notes');
  assert.deepEqual(notes.slides, { a: { notes: 'n' } });
  presenter.send({ t: 'meta', total: 10 });
  presenter.send({ t: 'step', delta: 1 });
  const v = await viewer.next(isState((m) => m.index === 1));
  const p = await presenter.next(isState((m) => m.index === 1));
  assert.equal(v.total, 10);
  assert.equal(p.viewers, 1);
  assert.ok(v.rev >= 2);
});

test('viewer commands are refused', async (t) => {
  const { connect } = await setup(t);
  const viewer = connect('viewer');
  await viewer.next(isState());
  viewer.send({ t: 'step', delta: 1 });
  assert.equal((await viewer.next((m) => m.t === 'error')).code, 'forbidden');
  assert.ok(!viewer.messages.some((m) => m.t === 'state' && m.index !== 0));
});

test('goto is clamped to total-1', async (t) => {
  const { connect } = await setup(t);
  const p = connect('presenter');
  await p.next(isState());
  p.send({ t: 'meta', total: 10 });
  p.send({ t: 'goto', index: 999 });
  assert.equal((await p.next(isState((m) => m.index !== 0))).index, 9);
});

test('two presenters stepping at once advance twice', async (t) => {
  const { connect } = await setup(t);
  const a = connect('presenter');
  const b = connect('presenter');
  await a.next(isState((m) => m.presenters === 2));
  await b.next(isState((m) => m.presenters === 2));
  a.send({ t: 'meta', total: 10 });
  a.send({ t: 'step', delta: 1 });
  b.send({ t: 'step', delta: 1 });
  await a.next(isState((m) => m.index === 2));
});

test('bad messages, blank, nav', async (t) => {
  const { connect } = await setup(t);
  const p = connect('presenter');
  await p.next(isState());
  p.send('not json');
  assert.equal((await p.next((m) => m.t === 'error')).code, 'bad-message');
  p.send({ t: 'explode' });
  assert.equal((await p.next((m) => m.t === 'error')).code, 'bad-message');
  p.send({ t: 'step', delta: 5 });
  assert.equal((await p.next((m) => m.t === 'error')).code, 'bad-message');
  p.send({ t: 'blank', on: true });
  await p.next(isState((m) => m.blank === true));
  p.send({ t: 'nav', mode: 'free' });
  await p.next(isState((m) => m.viewerNav === 'free'));
});

test('messages over 4 KB close the socket with 1009', async (t) => {
  const { connect } = await setup(t);
  const p = connect('presenter');
  await p.next(isState());
  p.send({ t: 'meta', pad: 'x'.repeat(5000) });
  assert.equal((await p.closed).code, 1009);
});

test('foreign Origin is rejected at the upgrade', async (t) => {
  const { connect } = await setup(t);
  const evil = connect('viewer', { origin: 'http://evil.example' });
  assert.equal(await evil.opened, false);
  const none = connect('viewer', { origin: null });
  assert.equal(await none.opened, false);
});

test('unknown deck closes with 4404, unauthorised presenter with 4401', async (t) => {
  const { urls } = await setup(t);
  const nodeck = wsClient(`${urls.ws}/ws/nope?role=viewer`);
  assert.equal((await nodeck.closed).code, 4404);
  // A proxied request is never local direct, so with no password it is refused.
  const proxied = wsClient(`${urls.ws}/ws/talk?role=presenter`, { headers: { 'Cf-Connecting-IP': '203.0.113.9' } });
  assert.equal((await proxied.closed).code, 4401);
});

test('live state survives a restart via live.json', async (t) => {
  const dirs = await tempDirs(t);
  {
    await makeDeck(dirs.dataDir, 'talk');
    const app = await buildServer(dirs);
    const urls = await listen(app);
    const p = wsClient(`${urls.ws}/ws/talk?role=presenter`);
    await p.next(isState());
    p.send({ t: 'meta', total: 10 });
    p.send({ t: 'goto', index: 4 });
    p.send({ t: 'blank', on: true });
    await p.next(isState((m) => m.blank));
    p.close();
    await app.close();
  }
  const app = await buildServer(dirs);
  const urls = await listen(app);
  onCleanup(t, () => app.close());
  const v = wsClient(`${urls.ws}/ws/talk?role=viewer`);
  const s = await v.next(isState());
  assert.equal(s.index, 4);
  assert.equal(s.blank, true);
  v.close();
});

test('clients that miss two pings are dropped', async (t) => {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk');
  const app = await buildServer({ ...dirs, heartbeatMs: 50 });
  onCleanup(t, () => app.close());
  await listen(app);
  const state = { missed: 0 };
  const fake = { readyState: 1, ping() {}, terminate() { state.terminated = true; }, send() {}, close() {} };
  const live = app.syncdeck.live;
  // Drive the heartbeat directly with a socket that never answers.
  const listeners = {};
  fake.on = (ev, fn) => { listeners[ev] = fn; };
  await live.handleConnection(fake, { params: { slug: 'talk' }, query: { role: 'viewer' }, headers: {}, raw: { socket: {} } });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(state.terminated, true);
});

test('changing the default viewer mode in the admin panel reaches connected viewers', async (t) => {
  const { connect, app } = await setup(t);
  const viewer = connect('viewer');
  await viewer.next(isState((m) => m.viewerNav === 'follow'));
  // Local direct with no admin password: implicit admin.
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/admin/decks/talk',
    headers: { host: 'syncdeck.test', origin: 'http://syncdeck.test' },
    payload: { viewerNav: 'free' },
  });
  assert.equal(res.statusCode, 200);
  await viewer.next(isState((m) => m.viewerNav === 'free'));
});

test('WebSocket connections are capped per address and in total', async (t) => {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk');
  const app = await buildServer({ ...dirs, trustProxy: true, wsLimits: { perIp: 2, total: 3 } });
  const urls = await listen(app);
  const clients = [];
  onCleanup(t, async () => {
    for (const c of clients) c.close();
    await app.close();
  });
  const from = (ip) => {
    const c = wsClient(`${urls.ws}/ws/talk?role=viewer`, { headers: { 'Cf-Connecting-IP': ip } });
    clients.push(c);
    return c;
  };
  const a1 = from('198.51.100.1');
  const a2 = from('198.51.100.1');
  await a1.next(isState());
  await a2.next(isState());
  const a3 = from('198.51.100.1');
  assert.equal((await a3.closed).code, 4429);
  const b1 = from('198.51.100.2');
  await b1.next(isState());
  const c1 = from('198.51.100.3');
  assert.equal((await c1.closed).code, 4429);
  // A closed connection frees its slot.
  a1.close();
  await a1.closed;
  await new Promise((r) => setTimeout(r, 50));
  const c2 = from('198.51.100.3');
  await c2.next(isState());
});
