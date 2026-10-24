import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { cleanName, cleanNote, slidingLimit, parseRoomPatch } from '../src/rooms.js';
import { onCleanup, tempDirs, makeDeck, listen, wsClient, openRooms } from './helpers.js';

const LOCAL = { host: 'localhost:4321', origin: 'http://localhost:4321' };
const REMOTE = { host: 'slidecast.test', origin: 'http://slidecast.test', 'cf-connecting-ip': '203.0.113.7' };
// Through a proxy, so never local direct (and never a presenter by accident).
const PROXIED = { 'X-Forwarded-For': '203.0.113.50' };

async function setup(t, { open = true, opts = {} } = {}) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk');
  await makeDeck(dirs.dataDir, 'other');
  const app = await buildServer({ ...dirs, ...opts });
  if (open) await openRooms(app, ['talk']);
  const urls = await listen(app);
  const clients = [];
  const ws = (role, o = {}) => {
    const c = wsClient(`${urls.ws}/ws/${o.slug ?? 'talk'}?role=${role}`, o);
    clients.push(c);
    return c;
  };
  // A participant: through a proxy, joining with a token (or as a new one).
  const viewer = (token = true, o = {}) => ws('viewer', { join: token, headers: PROXIED, ...o });
  const admin = (payload) => app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload });
  onCleanup(t, async () => {
    for (const c of clients) c.close();
    await app.close();
  });
  return { app, urls, ws, viewer, admin, ctx: app.slidecast };
}

const isYou = (pred = () => true) => (m) => m.t === 'you' && pred(m);
const isRoom = (pred = () => true) => (m) => m.t === 'room' && pred(m);

async function loginCookie(app, scope, password) {
  const res = await app.inject({ method: 'POST', url: '/api/login', headers: LOCAL, payload: { scope, password } });
  assert.equal(res.statusCode, 204);
  return `sc_session=${res.cookies.find((c) => c.name === 'sc_session').value}`;
}

// ---- pure helpers ------------------------------------------------------------

test('names and notes are cleaned', () => {
  assert.equal(cleanName('  María ‮  José\t'), 'María José');
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(null), null);
  assert.equal(cleanName(3), undefined);
  assert.equal([...cleanName('ñ'.repeat(60))].length, 40);
  assert.equal(cleanName('é'), 'é', 'NFC');
  assert.equal(cleanName('👩‍💻 Ana'), '👩‍💻 Ana', 'joined emoji survive');
  assert.equal(cleanNote(undefined), '');
  assert.equal(cleanNote('a\r\n\n\nb\u0007c'), 'a\nb c');
  assert.equal(cleanNote('1\n2\n3\n4\n5\n6\n7'), '1\n2\n3\n4\n5 6 7');
  assert.equal([...cleanNote('x'.repeat(500))].length, 280);
  assert.equal(cleanNote({}), undefined);
});

test('sliding limits count every window', () => {
  const l = slidingLimit([{ max: 2, ms: 5000 }, { max: 4, ms: 30_000 }]);
  l.hit(0);
  l.hit(1000);
  assert.equal(l.wait(2000), 3000);
  l.hit(5000);
  l.hit(6100);
  assert.equal(l.wait(12_000), 18_000, 'the 30 s window holds the 5th');
  assert.equal(l.wait(30_000), 0);
});

test('room patches are validated', () => {
  assert.deepEqual(parseRoomPatch({ open: true, maxViewers: 1000, maxPresenters: 1 }).patch, { open: true, maxViewers: 1000, maxPresenters: 1 });
  for (const bad of [{ maxViewers: 1001 }, { maxViewers: 0 }, { maxPresenters: 21 }, { maxPresenters: 2.5 }, { open: 'yes' }, { other: 1 }, null, []]) {
    assert.ok(parseRoomPatch(bad).error, JSON.stringify(bad));
  }
});

// ---- admin and pages ---------------------------------------------------------

test('rooms start closed; the admin opens one, or only one', async (t) => {
  const { app, ctx } = await setup(t, { open: false });
  assert.equal(ctx.rooms.isOpen('talk'), false);
  // A closed room hands its audience no deck link; presenters still get one.
  const closed = (await app.inject({ url: '/api/decks/talk', headers: REMOTE })).json();
  assert.equal(closed.open, false);
  assert.equal(closed.deckUrl, null);
  assert.ok((await app.inject({ url: '/api/decks/talk', headers: LOCAL })).json().deckUrl);
  assert.equal((await app.inject({ url: '/', headers: REMOTE })).statusCode, 200, 'nothing open: landing');

  assert.equal((await app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: REMOTE, payload: { open: true } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload: { maxViewers: 5000 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/admin/rooms/nope', headers: LOCAL, payload: { open: true } })).statusCode, 404);
  const res = await app.inject({ method: 'PATCH', url: '/api/admin/rooms/talk', headers: LOCAL, payload: { open: true, maxViewers: 30 } });
  assert.deepEqual(res.json(), { open: true, maxPresenters: 20, maxViewers: 30, askNames: true, hands: true });
  assert.equal((await app.inject({ url: '/', headers: REMOTE })).headers.location, '/talk');

  await app.inject({ method: 'PATCH', url: '/api/admin/rooms/other', headers: LOCAL, payload: { open: true } });
  const list = (await app.inject({ url: '/api/decks', headers: REMOTE })).json().decks.map((d) => d.slug);
  assert.deepEqual(list, ['other', 'talk'], 'the public list shows open rooms');
  await app.inject({ method: 'PATCH', url: '/api/admin/rooms/other', headers: LOCAL, payload: { only: true } });
  assert.equal(ctx.rooms.isOpen('talk'), false);
  assert.equal((await app.inject({ url: '/', headers: REMOTE })).headers.location, '/other');
  assert.equal(ctx.config.rooms.talk.maxViewers, 30, 'settings kept while closed');
  const rows = (await app.inject({ url: '/api/admin/decks', headers: LOCAL })).json().decks;
  assert.deepEqual(rows.find((d) => d.slug === 'other').room, {
    open: true, maxPresenters: 20, maxViewers: 200, askNames: true, hands: true, viewers: 0, presenters: 0, raised: 0,
  });
});

test('single-deck mode: the room is always open', async (t) => {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'solo');
  const app = await buildServer({ ...dirs, singleDeck: `${dirs.dataDir}/solo` });
  onCleanup(t, () => app.close());
  assert.equal(app.slidecast.rooms.isOpen('solo'), true);
  const res = await app.inject({ method: 'PATCH', url: '/api/admin/rooms/solo', headers: LOCAL, payload: { open: false } });
  assert.equal(res.statusCode, 409);
});

// ---- joining -----------------------------------------------------------------

test('a closed room parks viewers until it opens', async (t) => {
  const { viewer, admin } = await setup(t, { open: false });
  const v = viewer();
  assert.equal((await v.next((m) => m.t === 'wait')).reason, 'closed');
  assert.equal((await admin({ open: true })).statusCode, 200);
  assert.equal((await v.closed).code, 4000, 'told to reload');
  const again = viewer();
  await again.next(isYou());
});

test('participants get a number and a token; presenters see them, viewers never see others', async (t) => {
  const { viewer, ws } = await setup(t);
  const a = viewer();
  const youA = await a.next(isYou());
  assert.equal(youA.n, 1);
  assert.match(youA.token, /^[\w-]{43}$/);
  assert.equal((await a.next((m) => m.t === 'state')).index, 0);
  a.send({ t: 'name', name: '  Ana  ' });
  assert.equal((await a.next(isYou((m) => m.name === 'Ana'))).n, 1);
  const b = viewer();
  assert.equal((await b.next(isYou())).n, 2);
  const p = ws('presenter');
  const room = await p.next(isRoom((m) => m.people.length === 2 && m.people.some((x) => x.name === 'Ana')));
  assert.equal(room.viewers, 2);
  assert.ok(room.people.every((x) => !('hash' in x) && !('token' in x)));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(![...a.messages, ...b.messages].some((m) => m.t === 'room'), 'no room message to viewers');
  assert.ok(a.messages.every((m) => m.t !== 'you' || m.n === 1));
  assert.ok(!b.messages.some((m) => JSON.stringify(m).includes('Ana')));
});

test('a token brings the same participant back, hand included; after the grace period it is gone', async (t) => {
  const { viewer, ws } = await setup(t, { opts: { graceMs: 300 } });
  const a = viewer();
  const { token } = await a.next(isYou());
  a.send({ t: 'hand', up: true, note: 'my question' });
  await a.next(isYou((m) => m.hand?.state === 'raised'));
  a.close();
  await a.closed;
  const back = viewer(token);
  const you = await back.next(isYou());
  assert.equal(you.n, 1);
  assert.equal(you.hand.note, 'my question');
  back.close();
  await back.closed;
  const p = ws('presenter');
  await p.next(isRoom((m) => m.people.length === 0), 3000);
  const fresh = viewer(token);
  const again = await fresh.next(isYou());
  assert.equal(again.n, 1, 'numbering restarts once the room is empty');
  assert.equal(again.hand, null);
  assert.notEqual(again.token, token);
});

test('names can be turned off, and renames are limited', async (t) => {
  const { viewer, admin } = await setup(t);
  const a = viewer();
  await a.next(isYou());
  for (let i = 0; i < 5; i++) a.send({ t: 'name', name: `n${i}` });
  a.send({ t: 'name', name: 'six' });
  assert.equal((await a.next((m) => m.t === 'error')).code, 'slow-down');
  await admin({ askNames: false });
  await a.next((m) => m.t === 'state' && m.askNames === false);
  a.send({ t: 'name', name: 'x' });
  assert.equal((await a.next((m) => m.t === 'error')).code, 'names-off');
});

// ---- hands -------------------------------------------------------------------

test('hands: raise with a note, queue, attend, resolve', async (t) => {
  const { viewer, ws } = await setup(t);
  const a = viewer();
  const b = viewer();
  await a.next(isYou());
  await b.next(isYou());
  const p = ws('presenter');
  a.send({ t: 'hand', up: true, note: 'Why?' });
  b.send({ t: 'hand', up: true });
  const room = await p.next(isRoom((m) => m.people.filter((x) => x.hand).length === 2));
  const idA = room.people.find((x) => x.hand?.note === 'Why?').id;
  const idB = room.people.find((x) => x.hand?.note === '').id;
  a.send({ t: 'hand', up: true });
  assert.equal((await a.next((m) => m.t === 'error')).code, 'already-up');

  p.send({ t: 'hand', id: idB, action: 'queue' });
  assert.equal((await b.next(isYou((m) => m.hand?.state === 'queued'))).hand.pos, 1);
  p.send({ t: 'hand', id: idA, action: 'queue' });
  assert.equal((await a.next(isYou((m) => m.hand?.state === 'queued'))).hand.pos, 2);
  p.send({ t: 'hand', id: idB, action: 'attend' });
  await b.next(isYou((m) => m.hand?.state === 'attending'));
  assert.equal((await a.next(isYou((m) => m.hand?.pos === 1))).hand.state, 'queued', 'moves up');
  p.send({ t: 'hand', id: idB, action: 'resolve' });
  const done = await b.next(isYou((m) => m.resolved));
  assert.equal(done.hand, null);
  p.send({ t: 'hand', id: idA, action: 'nope' });
  assert.equal((await p.next((m) => m.t === 'error')).code, 'bad-message');

  // A participant lowers its own hand; "lower all" clears the rest.
  a.send({ t: 'hand', up: false });
  await a.next(isYou((m) => m.hand === null));
  b.send({ t: 'hand', up: true });
  await b.next(isYou((m) => m.hand?.state === 'raised'));
  p.send({ t: 'hands-clear' });
  await b.next(isYou((m) => m.hand === null && m.resolved));
});

test('raising is rate limited and can be turned off live', async (t) => {
  const { viewer, ws } = await setup(t);
  const a = viewer();
  await a.next(isYou());
  for (const up of [true, false, true, false]) a.send({ t: 'hand', up });
  a.send({ t: 'hand', up: true });
  const err = await a.next((m) => m.t === 'error');
  assert.equal(err.code, 'slow-down');
  assert.ok(err.wait > 0 && err.wait <= 5000);
  const p = ws('presenter');
  await p.next((m) => m.t === 'room');
  p.send({ t: 'hands', on: false });
  await a.next((m) => m.t === 'state' && m.hands === false);
  a.send({ t: 'hand', up: true });
  assert.equal((await a.next((m) => m.t === 'error')).code, 'hands-off');
  a.send({ t: 'step', delta: 1 });
  assert.equal((await a.next((m) => m.t === 'error')).code, 'forbidden');
});

// ---- kicks and limits ----------------------------------------------------------

test('a kicked participant stays out with its token; "no more people" parks new ones', async (t) => {
  const { viewer, ws } = await setup(t);
  const a = viewer();
  const { token } = await a.next(isYou());
  const p = ws('presenter');
  const room = await p.next(isRoom((m) => m.people.length === 1));
  p.send({ t: 'kick', id: room.people[0].id });
  assert.equal((await a.closed).code, 4403);
  assert.equal((await viewer(token).closed).code, 4403, 'a reload does not undo it');

  const b = viewer();
  const youB = await b.next(isYou());
  p.send({ t: 'lock', on: true });
  await p.next(isRoom((m) => m.locked));
  const c = viewer();
  assert.equal((await c.next((m) => m.t === 'wait')).reason, 'locked');
  b.close();
  await b.closed;
  const backB = viewer(youB.token);
  await backB.next(isYou((m) => m.n === youB.n)); // known people may reconnect
  p.send({ t: 'lock', on: false });
  assert.equal((await c.closed).code, 4000);
});

test('the viewer limit counts sockets; the presenter limit counts devices and spares the owner', async (t) => {
  const { app, viewer, ws, admin } = await setup(t);
  await admin({ maxViewers: 1, maxPresenters: 1 });
  const a = viewer();
  await a.next(isYou());
  assert.equal((await viewer().closed).code, 4409);

  await app.slidecast.auth.setPassword('admin', null, 'admin-pass1');
  await app.slidecast.auth.setPassword('presenter', null, 'presenter-pass1');
  const one = await loginCookie(app, 'presenter', 'presenter-pass1');
  const two = await loginCookie(app, 'presenter', 'presenter-pass1');
  const first = ws('presenter', { cookie: one, headers: PROXIED });
  await first.next(isRoom());
  const sameDevice = ws('viewer', { cookie: one, headers: PROXIED });
  await sameDevice.next((m) => m.t === 'state'); // the projector of the same device
  assert.equal((await ws('presenter', { cookie: two, headers: PROXIED }).closed).code, 4410);
  // The admin is the owner and always gets in, and may remove a presenter.
  const owner = ws('presenter', { cookie: await loginCookie(app, 'admin', 'admin-pass1'), headers: PROXIED });
  const room = await owner.next(isRoom((m) => m.presenters.length === 2));
  assert.equal(room.admin, true);
  const target = room.presenters.find((d) => !d.owner);
  assert.equal(target.windows, 1, 'a display does not count');
  first.send({ t: 'kick-presenter', id: room.presenters.find((d) => d.owner).id });
  assert.equal((await first.next((m) => m.t === 'error')).code, 'forbidden', 'only the admin');
  owner.send({ t: 'kick-presenter', id: target.id });
  assert.equal((await first.closed).code, 4401);
  assert.equal((await sameDevice.closed).code, 4401);
  const res = await app.inject({ url: '/api/decks/talk', headers: { ...REMOTE, cookie: one } });
  assert.equal(res.json().canPresent, false, 'its presenter rights are gone');
});

test('closing a room parks and forgets everyone in it', async (t) => {
  const { viewer, ws, admin } = await setup(t);
  const a = viewer();
  const { token } = await a.next(isYou());
  const p = ws('presenter');
  await p.next(isRoom((m) => m.people.length === 1));
  p.send({ t: 'lock', on: true });
  await admin({ open: false });
  assert.equal((await a.next((m) => m.t === 'wait')).reason, 'closed');
  const room = await p.next(isRoom((m) => !m.open));
  assert.deepEqual(room.people, []);
  assert.equal(room.locked, false);
  await admin({ open: true });
  assert.equal((await a.closed).code, 4000);
  const back = await viewer(token).next(isYou());
  assert.notEqual(back.token, token, 'a new participant');
});

test('a flooding participant is disconnected', async (t) => {
  const { viewer } = await setup(t);
  const a = viewer();
  await a.next(isYou());
  for (let i = 0; i < 40; i++) a.send({ t: 'hand', up: false });
  assert.equal((await a.closed).code, 1008);
});

test('new participants per address are limited', async (t) => {
  const { viewer } = await setup(t, { opts: { joinLimit: { max: 2 } } });
  await viewer().next(isYou());
  await viewer().next(isYou());
  assert.equal((await viewer().closed).code, 4429);
});

// ---- regressions from review ---------------------------------------------------

test('names stop reaching a presenter socket once it may no longer present', async (t) => {
  const { app, viewer, ws } = await setup(t);
  await app.slidecast.auth.setPassword('presenter', null, 'presenter-pass1');
  const cookie = await loginCookie(app, 'presenter', 'presenter-pass1');
  const p = ws('presenter', { cookie, headers: PROXIED });
  await p.next(isRoom());
  await app.inject({ method: 'POST', url: '/api/logout', headers: { ...LOCAL, cookie } });
  const a = viewer();
  await a.next(isYou());
  a.send({ t: 'name', name: 'Secret Name' });
  assert.equal((await p.closed).code, 4401);
  assert.ok(!p.messages.some((m) => JSON.stringify(m).includes('Secret Name')));
});

test('owner status is checked live: an admin whose session was revoked can be removed', async (t) => {
  const { app, ws } = await setup(t);
  await app.slidecast.auth.setPassword('admin', null, 'admin-pass1');
  await app.slidecast.auth.setPassword('presenter', null, 'presenter-pass1');
  const oldAdmin = await loginCookie(app, 'admin', 'admin-pass1');
  // The old admin also holds presenter rights in the same session.
  const res = await app.inject({ method: 'POST', url: '/api/login', headers: { ...LOCAL, cookie: oldAdmin }, payload: { scope: 'presenter', password: 'presenter-pass1' } });
  const both = `sc_session=${res.cookies.find((c) => c.name === 'sc_session').value}`;
  const target = ws('presenter', { cookie: both, headers: PROXIED });
  await target.next(isRoom((m) => m.admin === true));
  await app.slidecast.auth.setPassword('admin', null, 'admin-pass2'); // revokes every admin session
  const owner = ws('presenter', { cookie: await loginCookie(app, 'admin', 'admin-pass2'), headers: PROXIED });
  const room = await owner.next(isRoom((m) => m.presenters.length === 2));
  const victim = room.presenters.find((d) => !d.you);
  assert.equal(victim.owner, false);
  owner.send({ t: 'kick-presenter', id: victim.id });
  assert.equal((await target.closed).code, 4401);
});

test('queue positions move up when someone ahead is forgotten; a kick never reuses a number', async (t) => {
  const { viewer, ws } = await setup(t, { opts: { graceMs: 200 } });
  const a = viewer();
  const b = viewer();
  await a.next(isYou());
  await b.next(isYou());
  const p = ws('presenter');
  a.send({ t: 'hand', up: true });
  b.send({ t: 'hand', up: true });
  const room = await p.next(isRoom((m) => m.people.filter((x) => x.hand).length === 2));
  const [first, second] = room.people.sort((x, y) => x.n - y.n);
  p.send({ t: 'hand', id: first.id, action: 'queue' });
  await a.next(isYou((m) => m.hand?.pos === 1));
  p.send({ t: 'hand', id: second.id, action: 'queue' });
  await b.next(isYou((m) => m.hand?.pos === 2));
  a.close();
  assert.equal((await b.next(isYou((m) => m.hand?.pos === 1), 3000)).hand.state, 'queued');
  // B is now alone; removing B must not make the next newcomer "001" again.
  const after = await p.next(isRoom((m) => m.people.length === 1));
  p.send({ t: 'kick', id: after.people[0].id });
  await b.closed;
  assert.equal((await viewer().next(isYou())).n, 3);
});

test('turning names off makes everyone anonymous', async (t) => {
  const { viewer, ws, admin } = await setup(t);
  const a = viewer();
  await a.next(isYou());
  a.send({ t: 'name', name: 'Ana' });
  await a.next(isYou((m) => m.name === 'Ana'));
  const p = ws('presenter');
  await p.next(isRoom((m) => m.people[0]?.name === 'Ana'));
  await admin({ askNames: false });
  await a.next(isYou((m) => m.name === null));
  await p.next(isRoom((m) => m.people[0]?.name === null));
});

test('messages from a deleted deck\'s sockets do not crash the server', async (t) => {
  const { app, viewer } = await setup(t);
  const a = viewer();
  await a.next(isYou());
  app.slidecast.live.resetDeck('talk', { removed: true });
  a.send({ t: 'name', name: 'late' });
  await a.closed;
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
});
