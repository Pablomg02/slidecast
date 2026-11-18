import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { onCleanup, tempDirs, makeDeck, listen, wsClient, openRooms } from './helpers.js';

// Open screens follow layout changes (T4 of 0010): a change of `frozen`, or of
// the aspect of a frozen deck, closes every socket with 4000 (reload), and
// every state snapshot carries the layout.
const LOCAL = { host: 'localhost:4321', origin: 'http://localhost:4321' };
const PROXIED = { 'X-Forwarded-For': '203.0.113.50' };

async function setup(t) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk');
  const app = await buildServer(dirs);
  await openRooms(app, ['talk']);
  const urls = await listen(app);
  const clients = [];
  const ws = (role, o = {}) => {
    const c = wsClient(`${urls.ws}/ws/talk?role=${role}`, o);
    clients.push(c);
    return c;
  };
  onCleanup(t, async () => {
    for (const c of clients) c.close();
    await app.close();
  });
  const patch = (payload) => app.inject({ method: 'PATCH', url: '/api/admin/decks/talk', headers: LOCAL, payload });
  // A presenter, a display (the projector) and a participant, all in.
  async function screens() {
    const presenter = ws('presenter');
    const display = ws('viewer');
    const participant = ws('viewer', { join: true, headers: PROXIED });
    await presenter.next((m) => m.t === 'state');
    await display.next((m) => m.t === 'state');
    await participant.next((m) => m.t === 'you');
    return [presenter, display, participant];
  }
  return { app, dirs, ws, patch, screens };
}

// Resolves to the close codes, or 'open' for a socket still open after `ms`.
const codes = (list, ms = 300) => Promise.all(list.map((c) => Promise.race([
  c.closed.then((e) => e.code),
  new Promise((r) => { setTimeout(() => r('open'), ms); }),
])));

test('the state snapshot carries the layout', async (t) => {
  const { ws, patch } = await setup(t);
  const p = ws('presenter');
  assert.equal((await p.next((m) => m.t === 'state')).layout, null);
  await patch({ frozen: true });
  assert.deepEqual(await codes([p]), [4000]);
  const again = ws('presenter');
  assert.equal((await again.next((m) => m.t === 'state')).layout, '1920x1080');
});

test('turning frozen on closes every screen with 4000; so does a new aspect of a frozen deck', async (t) => {
  const { patch, screens } = await setup(t);
  let list = await screens();
  assert.equal((await patch({ frozen: true })).statusCode, 200);
  assert.deepEqual(await codes(list), [4000, 4000, 4000]);
  list = await screens();
  assert.equal((await patch({ aspect: '4:3' })).statusCode, 200);
  assert.deepEqual(await codes(list), [4000, 4000, 4000]);
  list = await screens();
  assert.equal((await patch({ aspect: '4:3', title: 'Same layout' })).statusCode, 200);
  assert.deepEqual(await codes(list), ['open', 'open', 'open'], 'same aspect: nothing to redraw');
  assert.equal((await patch({ frozen: false })).statusCode, 200);
  assert.deepEqual(await codes(list), [4000, 4000, 4000]);
});

test('the aspect of a deck that is not frozen, or only its title, closes nothing', async (t) => {
  const { patch, screens } = await setup(t);
  const list = await screens();
  assert.equal((await patch({ aspect: '4:3' })).statusCode, 200);
  assert.equal((await patch({ title: 'New' })).statusCode, 200);
  assert.equal((await patch({ frozen: false })).statusCode, 200);
  assert.deepEqual(await codes(list), ['open', 'open', 'open']);
});

test('a deck update whose deck.json flips frozen closes the screens; one that keeps it does not', async (t) => {
  const { app, dirs, screens } = await setup(t);
  const file = join(dirs.dataDir, 'talk', 'deck.json');
  const write = async (fields) => {
    let meta = {};
    try { meta = JSON.parse(await readFile(file, 'utf8')); } catch { /* none yet */ }
    await writeFile(file, JSON.stringify({ ...meta, ...fields }));
  };
  let list = await screens();
  await write({ title: 'Kept layout' });
  app.slidecast.live.resetDeck('talk');
  assert.deepEqual(await codes(list), ['open', 'open', 'open']);
  await write({ frozen: true });
  app.slidecast.live.resetDeck('talk');
  assert.deepEqual(await codes(list, 1000), [4000, 4000, 4000]);
  list = await screens();
  app.slidecast.live.resetDeck('talk');
  assert.deepEqual(await codes(list), ['open', 'open', 'open']);
});

test('the deck API returns the live layout while a live state exists', async (t) => {
  const { app, dirs, ws } = await setup(t);
  const get = async () => (await app.inject({ url: '/api/decks/talk', headers: LOCAL })).json().layout;
  assert.equal(await get(), null, 'no live state: from deck.json');
  const p = ws('presenter');
  await p.next((m) => m.t === 'state');
  // deck.json changed on disk without a deck update: the live value wins.
  await writeFile(join(dirs.dataDir, 'talk', 'deck.json'), JSON.stringify({ slidecast: 1, frozen: true }));
  assert.equal(await get(), null);
  assert.equal(app.slidecast.live.layoutOf('talk'), null);
  assert.equal(app.slidecast.live.layoutOf('nope'), undefined);
});

// deck.json reads held back on purpose, to race them with a saved setting.
function slowReads(app) {
  const decks = app.slidecast.decks;
  const real = decks.readMeta;
  const held = [];
  decks.readMeta = async (slug) => {
    const meta = await real(slug);
    await new Promise((r) => { held.push(r); });
    return meta;
  };
  return {
    release: async () => { while (held.length) held.shift()(); await settle(); },
    waiting: async () => { while (!held.length) await settle(5); },
    restore: () => { decks.readMeta = real; },
  };
}
const settle = (ms = 50) => new Promise((r) => { setTimeout(r, ms); });

test('frozen saved while the first screen is reading deck.json still freezes the room', async (t) => {
  const { app, ws, patch } = await setup(t);
  const slow = slowReads(app);
  const p = ws('presenter'); // its live state waits on the held read
  await slow.waiting();
  slow.restore();
  assert.equal((await patch({ frozen: true })).statusCode, 200);
  await slow.release();
  assert.equal((await p.next((m) => m.t === 'state')).layout, '1920x1080');
  assert.equal(app.slidecast.live.layoutOf('talk'), '1920x1080');
});

test('a deck update whose read started before a saved layout does not undo it', async (t) => {
  const { app, ws, patch } = await setup(t);
  const p = ws('presenter');
  await p.next((m) => m.t === 'state');
  const slow = slowReads(app);
  app.slidecast.live.resetDeck('talk'); // reads deck.json: still not frozen
  await slow.waiting();
  slow.restore();
  assert.equal((await patch({ frozen: true })).statusCode, 200);
  await slow.release();
  assert.equal(app.slidecast.live.layoutOf('talk'), '1920x1080');
  const api = await app.inject({ url: '/api/decks/talk', headers: LOCAL });
  assert.deepEqual([api.json().frozen, api.json().layout], [true, '1920x1080']);
});
