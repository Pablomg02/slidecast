// Starts a real syncdeck server for one e2e spec, with a temp data folder
// holding copies of the demo deck and the legacy fixture.
import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../../src/server.js';
import { issueDeckToken } from '../../src/tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

export async function startServer({ extraDecks = {}, config = {}, single = false, passwords = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'syncdeck-e2e-'));
  const dataDir = join(root, 'decks');
  const stateDir = join(root, 'state');
  await mkdir(dataDir);
  await cp(join(repo, 'examples', 'demo'), join(dataDir, 'demo'), { recursive: true });
  await cp(join(repo, 'test', 'fixtures', 'legacy-pres'), join(dataDir, 'legacy-pres'), { recursive: true });
  for (const [slug, html] of Object.entries(extraDecks)) {
    await mkdir(join(dataDir, slug));
    await writeFile(join(dataDir, slug, 'index.html'), html);
  }
  if (Object.keys(config).length) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'config.json'), JSON.stringify({ secret: 'e2e-secret-e2e-secret-e2e-secret-e2e-secr', ...config }));
  }
  const harness = await readFile(join(here, 'harness.html'), 'utf8');
  const app = await buildServer({
    dataDir,
    stateDir,
    singleDeck: single ? join(dataDir, 'demo') : null,
    extraRoutes: async (a) => {
      a.get('/__test/harness.html', (req, reply) => reply.type('text/html; charset=utf-8').send(harness));
    },
  });
  for (const [kind, pw] of Object.entries(passwords)) {
    const [k, slug] = kind.split(':');
    await app.syncdeck.auth.setPassword(k, slug ?? null, pw);
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const url = `http://127.0.0.1:${port}`;

  // Logs in through the API and returns the session cookie value.
  async function login(scope, password, deck) {
    const res = await fetch(`${url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ scope, password, deck }),
    });
    if (res.status !== 204) throw new Error(`login ${scope}: ${res.status}`);
    return /sd_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
  }

  // A presenter connection from the test process; state() waits for a match.
  function socket(slug, { role = 'presenter', cookie } = {}) {
    const headers = { Origin: url };
    if (cookie) headers.Cookie = `sd_session=${cookie}`;
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws/${slug}?role=${role}`, { headers });
    const states = [];
    let waiters = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t !== 'state') return;
      states.push(m);
      waiters = waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    };
    const opened = new Promise((r) => { ws.onopen = r; });
    return {
      states,
      async send(msg) { await opened; ws.send(JSON.stringify(msg)); },
      last: () => states.at(-1),
      state(pred, timeout = 3000) {
        const hit = states.findLast?.(pred) ?? [...states].reverse().find(pred);
        if (hit && hit === states.at(-1)) return Promise.resolve(hit);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no matching state; last ${JSON.stringify(states.at(-1))}`)), timeout);
          waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
        });
      },
      close: () => ws.close(),
    };
  }

  return {
    app,
    url,
    login,
    socket,
    root,
    dataDir,
    stateDir,
    deckUrl: (slug) => `/_deck/${slug}/${issueDeckToken(app.syncdeck.config.secret, slug)}/`,
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
