import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { onCleanup, tempDirs, makeDeck } from './helpers.js';

const HOST = 'syncdeck.test';
const ORIGIN = `http://${HOST}`;
// Not local direct: as seen through a tunnel.
const REMOTE = { host: HOST, 'cf-connecting-ip': '203.0.113.7' };

async function setup(t, slugs = ['talk']) {
  const dirs = await tempDirs(t);
  for (const s of slugs) await makeDeck(dirs.dataDir, s);
  const app = await buildServer(dirs);
  onCleanup(t, () => app.close());
  return { app, ctx: app.syncdeck, dirs };
}

async function adminCookie(app) {
  await app.syncdeck.auth.setPassword('admin', null, 'admin-password');
  const res = await app.inject({
    method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN },
    payload: { scope: 'admin', password: 'admin-password' },
  });
  assert.equal(res.statusCode, 204);
  return `sd_session=${res.cookies[0].value}`;
}

// What GET / should do, per D7.
function expected({ decks, featured, admin, publicListing }) {
  if (admin) return 'list';
  if (featured === 'set') return '302 /b';
  if (decks === 1) return '302 /a';
  return publicListing ? 'list' : 'landing';
}

test('root redirect matrix (D7)', async (t) => {
  for (const decks of [0, 1, 2]) {
    for (const featured of ['unset', 'set', 'missing']) {
      if (featured === 'set' && decks < 2) continue; // featured "b" exists only with 2 decks
      for (const admin of [false, true]) {
        for (const publicListing of [false, true]) {
          const { app, ctx } = await setup(t, ['a', 'b'].slice(0, decks));
          ctx.config.featured = featured === 'set' ? 'b' : featured === 'missing' ? 'gone' : null;
          ctx.config.publicListing = publicListing;
          const headers = { ...REMOTE };
          if (admin) headers.cookie = await adminCookie(app);
          const res = await app.inject({ url: '/', headers });
          const got = res.statusCode === 302 ? `302 ${res.headers.location}`
            : res.body.includes('/_syncdeck/list.js') ? 'list'
              : res.body.includes('/_syncdeck/landing.js') ? 'landing' : `?${res.statusCode}`;
          const want = expected({ decks, featured, admin, publicListing });
          assert.equal(got, want, JSON.stringify({ decks, featured, admin, publicListing }));
          const adm = await app.inject({ url: '/admin', headers });
          assert.ok(adm.statusCode < 300 || adm.statusCode >= 400, '/admin is never redirected');
          await app.close();
        }
      }
    }
  }
});

test('local direct without admin password is still redirected (only a real admin session sees the list)', async (t) => {
  const { app } = await setup(t, ['a']);
  const res = await app.inject({ url: '/' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/a');
});

test('deck API hides notes from viewers and shows them to presenters', async (t) => {
  const { app, ctx } = await setup(t);
  await ctx.decks.updateSlide('talk', 'intro', { notes: 'secret notes' });
  await ctx.auth.setPassword('presenter', null, 'presenter-pass');
  const anon = await app.inject({ url: '/api/decks/talk', headers: REMOTE });
  assert.equal(anon.statusCode, 200);
  const body = anon.json();
  assert.equal(body.notes, undefined);
  assert.equal(body.canPresent, false);
  assert.equal(body.canAdmin, false);
  assert.match(body.deckUrl, /^\/_deck\/talk\/\d+\.[A-Za-z0-9_-]{43}\/$/);
  assert.equal(body.viewerNav, 'back');
  const login = await app.inject({
    method: 'POST', url: '/api/login', headers: { ...REMOTE, origin: ORIGIN },
    payload: { scope: 'presenter', password: 'presenter-pass' },
  });
  const cookie = `sd_session=${login.cookies[0].value}`;
  const pres = await app.inject({ url: '/api/decks/talk', headers: { ...REMOTE, cookie } });
  assert.equal(pres.json().canPresent, true);
  assert.deepEqual(pres.json().notes, { intro: { notes: 'secret notes' } });
  // The deck URL actually serves the deck.
  const file = await app.inject({ url: pres.json().deckUrl });
  assert.equal(file.statusCode, 200);
});

test('a deck with a viewer password is closed to anonymous clients', async (t) => {
  const { app, ctx } = await setup(t);
  await ctx.auth.setPassword('deckViewer', 'talk', 'viewer-pass');
  assert.equal((await app.inject({ url: '/api/decks/talk', headers: REMOTE })).statusCode, 403);
  const page = await app.inject({ url: '/talk', headers: REMOTE });
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/talk/login?as=viewer');
  const view = await app.inject({ url: '/talk/view', headers: REMOTE });
  assert.equal(view.headers.location, '/talk/login?as=viewer');
  const login = await app.inject({
    method: 'POST', url: '/api/login', headers: { ...REMOTE, origin: ORIGIN },
    payload: { scope: 'viewer', deck: 'talk', password: 'viewer-pass' },
  });
  assert.equal(login.statusCode, 204);
  const cookie = `sd_session=${login.cookies[0].value}`;
  assert.equal((await app.inject({ url: '/talk', headers: { ...REMOTE, cookie } })).statusCode, 200);
});

test('deck pages, login page, 404 and headers', async (t) => {
  const { app, ctx } = await setup(t);
  await ctx.auth.setPassword('presenter', null, 'presenter-pass');
  const sel = await app.inject({ url: '/talk', headers: REMOTE });
  assert.equal(sel.statusCode, 200);
  assert.match(sel.body, /\/_syncdeck\/selector\.js/);
  assert.match(sel.headers['content-security-policy'], /default-src 'self'; script-src 'self'/);
  assert.equal(sel.headers['x-content-type-options'], 'nosniff');
  assert.equal(sel.headers['referrer-policy'], 'same-origin');
  const pres = await app.inject({ url: '/talk/present', headers: REMOTE });
  assert.equal(pres.headers.location, '/talk/login?as=presenter');
  assert.equal((await app.inject({ url: '/talk/present' })).statusCode, 200, 'local direct may present');
  assert.match((await app.inject({ url: '/talk/login', headers: REMOTE })).body, /login\.js/);
  assert.equal((await app.inject({ url: '/nope', headers: REMOTE })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/nope', headers: REMOTE })).json().error, 'not-found');
  assert.equal((await app.inject({ url: '/api/decks', headers: REMOTE })).statusCode, 403);
  ctx.config.publicListing = true;
  const [listed] = (await app.inject({ url: '/api/decks', headers: REMOTE })).json().decks;
  assert.deepEqual(Object.keys(listed).sort(), ['aspect', 'cover', 'deckUrl', 'slug', 'title']);
  assert.equal(listed.cover, null);
  assert.match(listed.deckUrl, /^\/_deck\/talk\/\d+\.[\w-]+\/$/);
  const md = await app.inject('/_syncdeck/vendor/markdown-it.min.js');
  assert.equal(md.statusCode, 200);
  assert.match(md.body, /markdownit/);
  const bridge = await app.inject('/_syncdeck/bridge.js');
  assert.equal(bridge.statusCode, 200);
});

test('deck list: cover image and locked decks', async (t) => {
  const { app, ctx, dirs } = await setup(t, ['talk', 'art', 'secret']);
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await writeFile(join(dirs.dataDir, 'talk', 'cover.png'), 'png');
  await mkdir(join(dirs.dataDir, 'art', 'img'));
  await writeFile(join(dirs.dataDir, 'art', 'img', 'first #1.jpg'), 'jpg');
  await writeFile(join(dirs.dataDir, 'art', 'deck.json'), JSON.stringify({ cover: 'img/first #1.jpg' }));
  await writeFile(join(dirs.dataDir, 'secret', 'cover.png'), 'png');
  await writeFile(join(dirs.dataDir, 'secret', 'deck.json'), JSON.stringify({ cover: '../talk/cover.png' }));
  await ctx.auth.setPassword('deckViewer', 'secret', 'viewer-pass');
  ctx.config.publicListing = true;
  const decks = Object.fromEntries((await app.inject({ url: '/api/decks', headers: REMOTE })).json().decks
    .map((d) => [d.slug, d]));
  assert.equal(decks.talk.cover, `${decks.talk.deckUrl}cover.png`);
  assert.equal(decks.art.cover, `${decks.art.deckUrl}img/first%20%231.jpg`);
  assert.deepEqual(decks.secret, { slug: 'secret', title: 'secret', locked: true });
  assert.equal((await app.inject({ url: decks.talk.cover, headers: REMOTE })).statusCode, 200);
  assert.equal((await app.inject({ url: decks.art.cover, headers: REMOTE })).body, 'jpg');
  const info = (await app.inject({ url: '/api/decks/talk', headers: REMOTE })).json();
  assert.equal(info.cover, `${info.deckUrl}cover.png`);
  // A cover path that leaves the deck folder is ignored (falls back to cover.png).
  assert.equal((await ctx.decks.get('secret')).cover, 'cover.png');
});
