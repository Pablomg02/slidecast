import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const root = await mkdtemp(join(tmpdir(), 'syncdeck-test-'));
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

// A WebSocket client that buffers messages; next(pred) waits for a match.
export function wsClient(url, { origin, cookie, headers = {} } = {}) {
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
  // Node's WebSocket fires only "error" (no "close") when the handshake is refused.
  const closedP = new Promise((resolve) => {
    socket.onclose = (e) => { closed = { code: e.code, reason: e.reason }; resolve(closed); };
    socket.onerror = () => { if (socket.readyState !== 1) resolve({ code: 1006, reason: 'error' }); };
  });
  const opened = new Promise((resolve) => {
    socket.onopen = () => resolve(true);
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
