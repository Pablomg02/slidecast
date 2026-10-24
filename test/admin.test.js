import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { buildServer } from '../src/server.js';
import { onCleanup, tempDirs, makeDeck, listen, wsClient } from './helpers.js';

const HOST = 'slidecast.test';
const ORIGIN = `http://${HOST}`;
const REMOTE = { host: HOST, origin: ORIGIN, 'cf-connecting-ip': '203.0.113.7' };

async function setup(t, { single = false } = {}) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk');
  const app = await buildServer({ ...dirs, singleDeck: single ? join(dirs.dataDir, 'talk') : null });
  onCleanup(t, () => app.close());
  await app.slidecast.auth.setPassword('admin', null, 'admin-password');
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: REMOTE, payload: { scope: 'admin', password: 'admin-password' } });
  assert.equal(login.statusCode, 204);
  const cookie = `sc_session=${login.cookies[0].value}`;
  const as = (opts) => app.inject({ ...opts, headers: { ...REMOTE, cookie, ...opts.headers } });
  return { app, dirs, as, cookie };
}

const ROUTES = [
  ['GET', '/api/admin/decks'],
  ['POST', '/api/admin/decks?slug=x'],
  ['DELETE', '/api/admin/decks/talk'],
  ['PATCH', '/api/admin/decks/talk'],
  ['PUT', '/api/admin/decks/talk/slides/intro'],
  ['GET', '/api/admin/settings'],
  ['PUT', '/api/admin/settings'],
  ['PUT', '/api/admin/passwords'],
];

test('every admin route answers 403 without an admin session', async (t) => {
  const { app, dirs } = await setup(t);
  for (const [method, url] of ROUTES) {
    const payload = method === 'POST' ? undefined : method === 'GET' || method === 'DELETE' ? undefined : {};
    const res = await app.inject({ method, url, headers: REMOTE, payload });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
  // A presenter session is not an admin session.
  await app.slidecast.auth.setPassword('presenter', null, 'presenter-pass');
  const p = await app.inject({ method: 'POST', url: '/api/login', headers: REMOTE, payload: { scope: 'presenter', password: 'presenter-pass' } });
  const res = await app.inject({ url: '/api/admin/decks', headers: { ...REMOTE, cookie: `sc_session=${p.cookies[0].value}` } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(await readdir(dirs.dataDir), ['talk'], 'nothing deleted');
});

test('upload a zip, then it is listed', async (t) => {
  const { as } = await setup(t);
  const zip = zipSync({ 'deck/index.html': strToU8('<title>Zipped</title>'), 'deck/a.css': strToU8('x') });
  const up = await as({ method: 'POST', url: '/api/admin/decks?slug=zipped', headers: { 'content-type': 'application/zip' }, payload: Buffer.from(zip) });
  assert.equal(up.statusCode, 201);
  const list = (await as({ url: '/api/admin/decks' })).json();
  const row = list.decks.find((d) => d.slug === 'zipped');
  assert.equal(row.title, 'Zipped');
  assert.equal(row.hasPresenterPassword, false);
  const html = await as({ method: 'POST', url: '/api/admin/decks?slug=page', headers: { 'content-type': 'text/html' }, payload: '<title>Page</title>' });
  assert.equal(html.statusCode, 201);
  const bad = await as({ method: 'POST', url: '/api/admin/decks?slug=evil', headers: { 'content-type': 'application/zip' }, payload: Buffer.from(zipSync({ '../x': strToU8('x') })) });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad-zip');
  const slug = await as({ method: 'POST', url: '/api/admin/decks?slug=admin', headers: { 'content-type': 'text/html' }, payload: 'x' });
  assert.equal(slug.json().error, 'bad-slug');
  const json = await as({ method: 'POST', url: '/api/admin/decks?slug=j', headers: { 'content-type': 'application/json' }, payload: {} });
  assert.equal(json.statusCode, 400);
});

test('upload and delete in single-deck mode → 409', async (t) => {
  const { as } = await setup(t, { single: true });
  const up = await as({ method: 'POST', url: '/api/admin/decks?slug=x', headers: { 'content-type': 'text/html' }, payload: '<p>x' });
  assert.equal(up.statusCode, 409);
  assert.deepEqual(up.json().error, 'single-deck');
  assert.equal((await as({ method: 'DELETE', url: '/api/admin/decks/talk' })).statusCode, 409);
  assert.equal((await as({ url: '/api/admin/decks' })).json().single, true);
});

test('PUT slide notes writes deck.json, keeps unknown fields and notifies presenters', async (t) => {
  const { app, dirs, as } = await setup(t);
  await writeFile(join(dirs.dataDir, 'talk', 'deck.json'), JSON.stringify({ slidecast: 1, extra: 1, slides: { intro: { other: true } } }));
  const urls = await listen(app);
  const presenter = wsClient(`${urls.ws}/ws/talk?role=presenter`); // loopback: local direct, no presenter password
  onCleanup(t, () => presenter.close());
  await presenter.next((m) => m.t === 'notes');
  const res = await as({ method: 'PUT', url: '/api/admin/decks/talk/slides/intro', payload: { notes: 'Hello **there**', steps: { 1: 'one' } } });
  assert.equal(res.statusCode, 200);
  const meta = JSON.parse(await readFile(join(dirs.dataDir, 'talk', 'deck.json'), 'utf8'));
  assert.equal(meta.extra, 1);
  assert.deepEqual(meta.slides.intro, { other: true, notes: 'Hello **there**', steps: { 1: 'one' } });
  const pushed = await presenter.next((m) => m.t === 'notes');
  assert.equal(pushed.slides.intro.notes, 'Hello **there**');
});

test('passwords: short → 400, admin cannot be cleared, deck scopes need a deck', async (t) => {
  const { as, app } = await setup(t);
  const put = (payload) => as({ method: 'PUT', url: '/api/admin/passwords', payload });
  assert.equal((await put({ scope: 'presenter', password: 'short' })).statusCode, 400);
  assert.equal((await put({ scope: 'presenter', password: 'short' })).json().error, 'password-too-short');
  assert.equal((await put({ scope: 'presenter', password: 'letters-only' })).json().error, 'password-too-weak');
  assert.equal((await put({ scope: 'admin', password: null })).json().error, 'cannot-clear-admin');
  assert.equal((await put({ scope: 'deckViewer', deck: 'nope', password: 'long-enough1' })).json().error, 'no-deck');
  assert.equal((await put({ scope: 'deckViewer', deck: 'talk', password: 'long-enough1' })).statusCode, 204);
  assert.equal((await as({ url: '/api/admin/decks' })).json().decks[0].hasViewerPassword, true);
  assert.equal((await put({ scope: 'deckViewer', deck: 'talk', password: null })).statusCode, 204);
  assert.equal(app.slidecast.config.decks.talk, undefined);
});

test('changing the admin password keeps the requester signed in on a new session', async (t) => {
  const { app, cookie } = await setup(t);
  const res = await app.inject({ method: 'PUT', url: '/api/admin/passwords', headers: { ...REMOTE, cookie }, payload: { scope: 'admin', password: 'new-admin-password1' } });
  assert.equal(res.statusCode, 204);
  const fresh = `sc_session=${res.cookies[0].value}`;
  assert.notEqual(fresh, cookie);
  assert.equal((await app.inject({ url: '/api/admin/settings', headers: { ...REMOTE, cookie } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/admin/settings', headers: { ...REMOTE, cookie: fresh } })).statusCode, 200);
});

test('settings, featured, PATCH and DELETE', async (t) => {
  const { as, dirs, app } = await setup(t);
  assert.equal((await as({ method: 'PUT', url: '/api/admin/settings', payload: { featured: 'nope' } })).statusCode, 400);
  const s = await as({ method: 'PUT', url: '/api/admin/settings', payload: { featured: 'talk', publicListing: true } });
  assert.deepEqual(s.json(), {
    featured: 'talk',
    publicListing: true,
    appearance: { siteName: null, landingText: null, accent: null, showCredit: true },
  });
  const patch = await as({ method: 'PATCH', url: '/api/admin/decks/talk', payload: { title: 'New title', viewerNav: 'follow' } });
  assert.deepEqual(patch.json(), { title: 'New title', viewerNav: 'follow', aspect: '16:9' });
  assert.equal((await as({ method: 'PATCH', url: '/api/admin/decks/talk', payload: { viewerNav: 'x' } })).statusCode, 400);
  const del = await as({ method: 'DELETE', url: '/api/admin/decks/talk' });
  assert.equal(del.statusCode, 204);
  assert.deepEqual(await readdir(dirs.dataDir), []);
  assert.match((await readdir(join(dirs.stateDir, 'trash')))[0], /^talk-/);
  assert.equal(app.slidecast.config.featured, null);
  assert.equal((await as({ method: 'DELETE', url: '/api/admin/decks/talk' })).statusCode, 404);
});

test('appearance: validated, saved, and shown on the pages', async (t) => {
  const { as, app, dirs } = await setup(t);
  for (const bad of [
    { siteName: 'x'.repeat(61) }, { landingText: 3 }, { accent: 'red' }, { accent: '#12345' },
    { showCredit: 'no' }, { other: 1 }, 'text',
  ]) {
    assert.equal((await as({ method: 'PUT', url: '/api/admin/settings', payload: { appearance: bad } })).statusCode, 400, JSON.stringify(bad));
  }
  const s = await as({
    method: 'PUT', url: '/api/admin/settings',
    payload: { appearance: { siteName: ' Charlas <b>&</b> "Pablo" ', landingText: 'Hola', accent: '#E11D48', showCredit: false } },
  });
  assert.equal(s.statusCode, 200);
  assert.deepEqual(s.json().appearance, { siteName: 'Charlas <b>&</b> "Pablo"', landingText: 'Hola', accent: '#e11d48', showCredit: false });
  const saved = JSON.parse(await readFile(join(dirs.stateDir, 'config.json'), 'utf8'));
  assert.equal(saved.appearance.accent, '#e11d48');

  const page = await app.inject({ url: '/talk', headers: REMOTE });
  assert.match(page.body, /<title>Charlas &#60;b&#62;&#38;&#60;\/b&#62; &#34;Pablo&#34;<\/title>/);
  assert.match(page.body, /<meta name="slidecast-appearance" content="[^"<>]*">/);
  assert.match(page.body, /<link rel="stylesheet" href="\/_slidecast\/theme.css">/);
  const css = await app.inject({ url: '/_slidecast/theme.css', headers: REMOTE });
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.match(css.body, /--accent: #e11d48;/);

  // A partial update keeps the other fields; empty strings and null reset.
  const r = await as({ method: 'PUT', url: '/api/admin/settings', payload: { appearance: { siteName: '', accent: null } } });
  assert.deepEqual(r.json().appearance, { siteName: null, landingText: 'Hola', accent: null, showCredit: false });
  const plain = await app.inject({ url: '/talk', headers: REMOTE });
  assert.match(plain.body, /<title>Slidecast<\/title>/);
  assert.doesNotMatch(plain.body, /theme\.css/);
  assert.equal((await app.inject({ url: '/_slidecast/theme.css', headers: REMOTE })).body, '');
});

test('/admin serves the panel to admins and the login page otherwise, never framed', async (t) => {
  const { app, cookie } = await setup(t);
  const anon = await app.inject({ url: '/admin', headers: REMOTE });
  assert.equal(anon.statusCode, 200);
  assert.match(anon.body, /admin-login\.js/);
  assert.match(anon.headers['content-security-policy'], /frame-ancestors 'none'/);
  const adm = await app.inject({ url: '/admin', headers: { ...REMOTE, cookie } });
  assert.match(adm.body, /\/_slidecast\/admin\.js/);
  const edit = await app.inject({ url: '/admin/edit/talk', headers: REMOTE });
  assert.equal(edit.statusCode, 302);
  assert.equal((await app.inject({ url: '/admin/edit/talk', headers: { ...REMOTE, cookie } })).statusCode, 200);
});
