import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { buildServer } from '../src/server.js';
import { DECK_CSP } from '../src/deckfiles.js';
import { issueDeckToken } from '../src/tokens.js';
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
  ['PATCH', '/api/admin/rooms/talk'],
  ['GET', '/api/admin/decks/talk/download'],
  ['POST', '/api/admin/decks/talk/stage'],
  ['POST', '/api/admin/stages/aaaaaaaaaaaa/diff'],
  ['POST', '/api/admin/stages/aaaaaaaaaaaa/commit'],
  ['DELETE', '/api/admin/stages/aaaaaaaaaaaa'],
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

test('settings, PATCH and DELETE', async (t) => {
  const { as, dirs, app } = await setup(t);
  const s = await as({ method: 'PUT', url: '/api/admin/settings', payload: { publicListing: false } });
  assert.deepEqual(s.json(), {
    publicListing: false,
    appearance: { siteName: null, landingText: null, accent: null, showLogo: true, showCredit: true },
  });
  const patch = await as({ method: 'PATCH', url: '/api/admin/decks/talk', payload: { title: 'New title', viewerNav: 'follow' } });
  assert.deepEqual(patch.json(), { title: 'New title', viewerNav: 'follow', aspect: '16:9' });
  assert.equal((await as({ method: 'PATCH', url: '/api/admin/decks/talk', payload: { viewerNav: 'x' } })).statusCode, 400);
  const del = await as({ method: 'DELETE', url: '/api/admin/decks/talk' });
  assert.equal(del.statusCode, 204);
  assert.deepEqual(await readdir(dirs.dataDir), []);
  assert.match((await readdir(join(dirs.stateDir, 'trash')))[0], /^talk-/);
  assert.equal(app.slidecast.config.rooms.talk, undefined);
  assert.equal((await as({ method: 'DELETE', url: '/api/admin/decks/talk' })).statusCode, 404);
});

test('appearance: validated, saved, and shown on the pages', async (t) => {
  const { as, app, dirs } = await setup(t);
  for (const bad of [
    { siteName: 'x'.repeat(61) }, { landingText: 3 }, { accent: 'red' }, { accent: '#12345' },
    { showLogo: 1 }, { showCredit: 'no' }, { other: 1 }, 'text',
  ]) {
    assert.equal((await as({ method: 'PUT', url: '/api/admin/settings', payload: { appearance: bad } })).statusCode, 400, JSON.stringify(bad));
  }
  const s = await as({
    method: 'PUT', url: '/api/admin/settings',
    payload: { appearance: { siteName: ' Charlas <b>&</b> "Pablo" ', landingText: 'Hola', accent: '#E11D48', showLogo: false, showCredit: false } },
  });
  assert.equal(s.statusCode, 200);
  assert.deepEqual(s.json().appearance, { siteName: 'Charlas <b>&</b> "Pablo"', landingText: 'Hola', accent: '#e11d48', showLogo: false, showCredit: false });
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
  assert.deepEqual(r.json().appearance, { siteName: null, landingText: 'Hola', accent: null, showLogo: false, showCredit: false });
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

test('download gives a zip that uploads back to the same deck', async (t) => {
  const { as, dirs } = await setup(t);
  const zip = zipSync({
    'index.html': strToU8('<title>Round</title>'),
    'img/a.png': new Uint8Array([9, 8, 7]),
    'deck.json': strToU8('{"slidecast":1,"title":"Round trip","slides":{"a":{"notes":"n"}},"extra":true}'),
  });
  await as({ method: 'POST', url: '/api/admin/decks?slug=round', headers: { 'content-type': 'application/zip' }, payload: Buffer.from(zip) });
  const before = await readFile(join(dirs.dataDir, 'round', 'deck.json'));
  const res = await as({ url: '/api/admin/decks/round/download' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="round.zip"');
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(res.rawPayload))).sort(), ['deck.json', 'img/a.png', 'index.html']);

  assert.equal((await as({ method: 'DELETE', url: '/api/admin/decks/round' })).statusCode, 204);
  const up = await as({ method: 'POST', url: '/api/admin/decks?slug=round', headers: { 'content-type': 'application/zip' }, payload: res.rawPayload });
  assert.equal(up.statusCode, 201);
  assert.ok((await readFile(join(dirs.dataDir, 'round', 'deck.json'))).equals(before));
  assert.deepEqual([...await readFile(join(dirs.dataDir, 'round', 'img', 'a.png'))], [9, 8, 7]);

  assert.equal((await as({ url: '/api/admin/decks/nope/download' })).statusCode, 404);
});

test('download of a deck without deck.json includes the defaults', async (t) => {
  const { as } = await setup(t);
  const res = await as({ url: '/api/admin/decks/talk/download' });
  const meta = JSON.parse(Buffer.from(unzipSync(new Uint8Array(res.rawPayload))['deck.json']).toString());
  assert.deepEqual(meta, { slidecast: 1, aspect: '16:9', viewerNav: 'back', slides: {} });
});

test('download works in single-deck mode', async (t) => {
  const { as } = await setup(t, { single: true });
  const res = await as({ url: '/api/admin/decks/talk/download' });
  assert.equal(res.statusCode, 200);
  assert.ok(unzipSync(new Uint8Array(res.rawPayload))['index.html']);
});

// ---- update in two phases (0004) ------------------------------------------

const DECK_V1 = {
  'index.html': strToU8('<title>V1</title>'),
  'deck.json': strToU8(JSON.stringify({ slidecast: 1, slides: { a: { notes: 'A', steps: { 1: 'a1', 2: 'a2' } }, b: { notes: 'B' } } })),
};

async function stageAs(as, slug, files) {
  return as({ method: 'POST', url: `/api/admin/decks/${slug}/stage`, headers: { 'content-type': 'application/zip' }, payload: Buffer.from(zipSync(files)) });
}

test('stage, diff and commit update the deck and prune notes', async (t) => {
  const { app, as, dirs } = await setup(t);
  await as({ method: 'POST', url: '/api/admin/decks?slug=up', headers: { 'content-type': 'application/zip' }, payload: Buffer.from(zipSync(DECK_V1)) });
  const st = await stageAs(as, 'up', { 'index.html': strToU8('<title>V2</title>') });
  assert.equal(st.statusCode, 201);
  const body = st.json();
  assert.match(body.id, /^[0-9a-f]{12}$/);
  assert.match(body.deckUrl, new RegExp(`^/_stage/${body.id}/[^/]+/$`));
  assert.deepEqual({ ...body, id: 0, deckUrl: 0 }, {
    id: 0, deckUrl: 0, hasIncoming: false, incomingInvalid: false, same: false, live: { viewers: 0, presenters: 0, raised: 0 },
  });
  const steps = [{ slide: 'a', step: 0 }, { slide: 'a', step: 1 }];
  const diff = await as({ method: 'POST', url: `/api/admin/stages/${body.id}/diff`, payload: { steps } });
  assert.equal(diff.statusCode, 200);
  assert.deepEqual(diff.json(), {
    current: { kept: 1, removedSlides: ['b'], removedSteps: [{ slide: 'a', step: 2 }], positional: false, checked: true },
    incoming: null,
  });
  assert.equal((await as({ method: 'POST', url: `/api/admin/stages/${body.id}/diff`, payload: { steps: 'x' } })).statusCode, 400);
  const commit = await as({ method: 'POST', url: `/api/admin/stages/${body.id}/commit`, payload: { notes: 'current', steps } });
  assert.equal(commit.statusCode, 200);
  assert.deepEqual(commit.json(), { slug: 'up', removedSlides: ['b'], removedSteps: [{ slide: 'a', step: 2 }] });
  const meta = JSON.parse(await readFile(join(dirs.dataDir, 'up', 'deck.json'), 'utf8'));
  assert.deepEqual(meta.slides, { a: { notes: 'A', steps: { 1: 'a1' } } });
  const again = await as({ method: 'POST', url: `/api/admin/stages/${body.id}/commit`, payload: { notes: 'current', steps } });
  assert.equal(again.statusCode, 404);
  assert.equal(again.json().error, 'stage-gone');
  assert.equal((await as({ url: '/api/admin/decks' })).json().decks.find((d) => d.slug === 'up').title, 'V2');
  assert.equal((await stageAs(as, 'nope', DECK_V1)).statusCode, 404);
  const empty = await as({ method: 'POST', url: '/api/admin/decks/up/stage', headers: { 'content-type': 'text/html' }, payload: '' });
  assert.equal(empty.json().error, 'empty-body');
  assert.ok(app);
});

test('a commit after the deck was replaced answers 409 deck-changed', async (t) => {
  const { as } = await setup(t);
  const { id } = (await stageAs(as, 'talk', { 'index.html': strToU8('<title>V2</title>') })).json();
  await as({ method: 'POST', url: '/api/admin/decks?slug=talk', headers: { 'content-type': 'text/html' }, payload: '<title>Other</title>' });
  const res = await as({ method: 'POST', url: `/api/admin/stages/${id}/commit`, payload: { notes: 'current', steps: null } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'deck-changed');
});

test('choosing the zip deck.json applies its viewer mode live', async (t) => {
  const { app, as } = await setup(t);
  const urls = await listen(app);
  const presenter = wsClient(`${urls.ws}/ws/talk?role=presenter`);
  onCleanup(t, () => presenter.close());
  await presenter.next((m) => m.t === 'notes');
  assert.equal(app.slidecast.live.getState('talk').viewerNav, 'back');
  const st = (await stageAs(as, 'talk', {
    'index.html': strToU8('<title>V2</title>'),
    'deck.json': strToU8('{"slidecast":1,"viewerNav":"free","slides":{}}'),
  })).json();
  assert.equal(st.hasIncoming, true);
  assert.equal(st.live.presenters, 1);
  const res = await as({ method: 'POST', url: `/api/admin/stages/${st.id}/commit`, payload: { notes: 'incoming', steps: null } });
  assert.equal(res.statusCode, 200);
  assert.equal(app.slidecast.live.getState('talk').viewerNav, 'free');
});

test('staged files are served like a deck, only with their own token', async (t) => {
  const { app, as } = await setup(t);
  const { id, deckUrl } = (await stageAs(as, 'talk', {
    'index.html': strToU8('<!doctype html><html><head><title>S</title></head></html>'),
    'deck.json': strToU8('{}'),
  })).json();
  const page = await app.inject(deckUrl);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<head><script src="\/_slidecast\/bridge\.js"><\/script><title>S/);
  assert.equal(page.headers['content-security-policy'], DECK_CSP);
  assert.equal((await app.inject(`${deckUrl}deck.json`)).statusCode, 404);
  assert.equal((await app.inject(`/_stage/${id}/123.abc/`)).statusCode, 403);
  const slugToken = issueDeckToken(app.slidecast.config.secret, `stage-${id}`);
  assert.equal((await app.inject(`/_stage/${id}/${slugToken}/`)).statusCode, 403);
  assert.equal((await as({ method: 'DELETE', url: `/api/admin/stages/${id}` })).statusCode, 204);
  assert.equal((await app.inject(deckUrl)).statusCode, 404);
  assert.equal((await as({ method: 'DELETE', url: `/api/admin/stages/${id}` })).statusCode, 204);
});

test('stage in single-deck mode → 409', async (t) => {
  const { as } = await setup(t, { single: true });
  const res = await stageAs(as, 'talk', DECK_V1);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'single-deck');
});

test('a download fails rather than mix versions when the deck is replaced meanwhile', async (t) => {
  const { app, as, cookie } = await setup(t);
  const zip = zipSync({ 'index.html': strToU8('<title>Big</title>'), 'img/a.png': new Uint8Array(8 * 1024 * 1024) });
  await as({ method: 'POST', url: '/api/admin/decks?slug=big', headers: { 'content-type': 'application/zip' }, payload: Buffer.from(zip) });
  const urls = await listen(app);
  const res = await fetch(`${urls.http}/api/admin/decks/big/download`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read();
  await as({ method: 'POST', url: '/api/admin/decks?slug=big', headers: { 'content-type': 'text/html' }, payload: '<title>New</title>' });
  await assert.rejects((async () => { for (;;) if ((await reader.read()).done) break; })());
});
