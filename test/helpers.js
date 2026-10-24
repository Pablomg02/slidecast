import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Node 20 has no global WebSocket; ws is what @fastify/websocket runs on.
import WebSocket from 'ws';

const cleanups = new WeakMap();

// Runs fn when the test ends, last registered first (t.after runs in order).
export function onCleanup(t, fn) {
  let list = cleanups.get(t);
  if (!list) {
    list = [];
    cleanups.set(t, list);
    t.after(async () => {
      for (const f of list.reverse()) await f();
    });
  }
  list.push(fn);
}

// Fresh data and state folders, removed when the test ends.
export async function tempDirs(t) {
  const root = await mkdtemp(join(tmpdir(), 'slidecast-test-'));
  const dataDir = join(root, 'decks');
  const stateDir = join(root, 'state');
  await mkdir(dataDir);
  onCleanup(t, () => rm(root, { recursive: true, force: true }));
  return { root, dataDir, stateDir };
}

// Writes a minimal deck folder.
export async function makeDeck(dataDir, slug, { html, meta } = {}) {
  const { writeFile: wf } = await import('node:fs/promises');
  await mkdir(join(dataDir, slug), { recursive: true });
  await wf(join(dataDir, slug, 'index.html'),
    html ?? `<!doctype html><html><head><title>${slug}</title></head><body></body></html>`);
  if (meta) await wf(join(dataDir, slug, 'deck.json'), JSON.stringify(meta));
}

export async function listen(app) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}

// Opens rooms (decks start closed, D1 of 0003).
export async function openRooms(app, slugs) {
  for (const slug of slugs) await app.slidecast.rooms.update(slug, { open: true });
}

// A WebSocket client that buffers messages; next(pred) waits for a match.
// With `join`, it joins the room as a participant once open (true: as a new
// one; a string: with that token).
export function wsClient(url, { origin, cookie, headers = {}, join } = {}) {
  const h = { ...headers };
  if (origin !== null) h.Origin = origin ?? new URL(url.replace(/^ws/, 'http')).origin;
  if (cookie) h.Cookie = cookie;
  const socket = new WebSocket(url, { headers: h });
  const messages = [];
  const waiters = [];
  let closed = null;
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    messages.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  };
  // A refused handshake may fire only "error", without "close".
  const closedP = new Promise((resolve) => {
    socket.onclose = (e) => { closed = { code: e.code, reason: e.reason }; resolve(closed); };
    socket.onerror = () => { if (socket.readyState !== 1) resolve({ code: 1006, reason: 'error' }); };
  });
  const opened = new Promise((resolve) => {
    socket.onopen = () => {
      if (join) socket.send(JSON.stringify({ t: 'join', token: join === true ? null : join }));
      resolve(true);
    };
    closedP.then(() => resolve(false));
  });
  return {
    socket,
    messages,
    opened,
    closed: closedP,
    send: (m) => socket.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next(pred = () => true, timeout = 2000) {
      const found = messages.find(pred);
      if (found) { messages.splice(messages.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (m) => { clearTimeout(timer); messages.splice(messages.indexOf(m), 1); resolve(m); } };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timeout waiting for message; got ${JSON.stringify(messages)}`));
        }, timeout);
        waiters.push(w);
      });
    },
    close: () => socket.close(),
  };
}
