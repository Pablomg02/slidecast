import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildServer } from '../src/server.js';
import { parseAudienceUrl, audienceBase, lanAddresses, joinLinks, isLoopbackName } from '../src/share.js';
import { onCleanup, tempDirs, makeDeck, listen, wsClient, openRooms, passwd } from './helpers.js';

// The join screen (0011): QR, address and viewer password on the screens.

const LOCAL = { host: 'localhost:4321', origin: 'http://localhost:4321' };
const PROXIED = { 'X-Forwarded-For': '203.0.113.50' };
const POLL = { question: 'Ready?', options: ['yes', 'no'] };

async function setup(t) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk', { meta: { slidecast: 1, slides: { q: { poll: POLL } } } });
  const app = await buildServer(dirs);
  await openRooms(app, ['talk']);
  const urls = await listen(app);
  const clients = [];
  const ws = (role, o = {}) => {
    const c = wsClient(`${urls.ws}/ws/talk?role=${role}`, o);
    clients.push(c);
    return c;
  };
  const presenter = async (o) => {
    const c = ws('presenter', o);
    await c.next(isShare());
    return c;
  };
  // The projector: a viewer page with presenter rights.
  const display = async (o) => {
    const c = ws('viewer', o);
    await c.next(isShare());
    return c;
  };
  const participant = async () => {
    const c = ws('viewer', { join: true, headers: PROXIED });
    await c.next((m) => m.t === 'you');
    return c;
  };
  const admin = (method, url, payload) => app.inject({ method, url, headers: LOCAL, payload });
  onCleanup(t, async () => {
    for (const c of clients) c.close();
    await app.close();
  });
  const configOnDisk = async () => JSON.parse(await readFile(join(dirs.stateDir, 'config.json'), 'utf8'));
  return { app, dirs, urls, ws, presenter, display, participant, admin, configOnDisk, ctx: app.slidecast };
}

const isShare = (pred = () => true) => (m) => m.t === 'share' && pred(m);

// ---- pure helpers ------------------------------------------------------------

test('the audience address: only an http(s) origin, typed with its scheme', () => {
  assert.deepEqual(parseAudienceUrl('https://Slides.Example.org/'), { value: 'https://slides.example.org' });
  assert.deepEqual(parseAudienceUrl(' http://192.168.1.20:4321 '), { value: 'http://192.168.1.20:4321' });
  assert.deepEqual(parseAudienceUrl(''), { value: null });
  assert.deepEqual(parseAudienceUrl(null), { value: null });
  for (const bad of ['slides.example.org', 'ftp://x.org', 'https://x.org/deck', 'https://u:p@x.org', 'https://x.org/?a=1',
    'javascript:alert(1)', `https://${'a'.repeat(100)}.org`, 42]) {
    assert.deepEqual(parseAudienceUrl(bad), { error: 'bad-audience-url' }, String(bad));
  }
});

test('which address a screen shows', () => {
  const lan = () => ['192.168.1.20'];
  const listenAll = { address: '0.0.0.0', port: 4321 };
  // The admin's address wins.
  assert.equal(audienceBase({ configured: 'https://slides.example.org', origin: 'http://localhost:4321', listen: listenAll, lan }), 'https://slides.example.org');
  // Else the screen's own, unless it is this computer's.
  assert.equal(audienceBase({ origin: 'https://slides.example.org', listen: listenAll, lan }), 'https://slides.example.org');
  assert.equal(audienceBase({ origin: 'http://192.168.1.20:4321', listen: null, lan }), 'http://192.168.1.20:4321');
  // localhost: the LAN address, when the server listens there.
  for (const origin of ['http://localhost:4321', 'http://127.0.0.1:4321', 'http://[::1]:4321', 'http://app.localhost:4321', null, 'nonsense']) {
    assert.equal(audienceBase({ origin, listen: listenAll, lan }), 'http://192.168.1.20:4321', String(origin));
    assert.equal(audienceBase({ origin, listen: { address: '::', port: 80 }, lan }), 'http://192.168.1.20', 'port 80 left out');
    assert.equal(audienceBase({ origin, listen: { address: '127.0.0.1', port: 4321 }, lan }), null, 'phones cannot reach it');
    assert.equal(audienceBase({ origin, listen: { address: '::1', port: 4321 }, lan }), null);
    assert.equal(audienceBase({ origin, listen: { address: '10.0.0.5', port: 4321 }, lan }), 'http://10.0.0.5:4321');
    assert.equal(audienceBase({ origin, listen: listenAll, lan: () => [] }), null, 'no network');
    assert.equal(audienceBase({ origin, listen: null, lan }), null);
  }
  assert.ok(isLoopbackName('LOCALHOST.') && !isLoopbackName('192.168.1.2'));
  assert.deepEqual(joinLinks('https://slides.example.org', 'talk'), { url: 'https://slides.example.org/talk/view', text: 'slides.example.org/talk' });
  assert.deepEqual(joinLinks(null, 'talk'), { url: null, text: null });
});

test('LAN addresses skip loopback, bridges, VPNs and link-local, private ones first', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    'br-1a2b': [{ family: 'IPv4', address: '172.18.0.1', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.64.0.3', internal: false }],
    eth1: [{ family: 'IPv4', address: '203.0.113.9', internal: false }],
    wlan0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false }],
    eth2: [{ family: 4, address: '169.254.3.4', internal: false }],
  };
  assert.deepEqual(lanAddresses(ifaces), ['192.168.1.20', '203.0.113.9']);
});

// ---- live ----------------------------------------------------------------------

test('a presenter puts the join screen on every screen; the audience never gets it', async (t) => {
  const { presenter, display, participant, admin, ws } = await setup(t);
  await admin('PUT', '/api/admin/settings', { audienceUrl: 'https://slides.example.org' });
  const p = await presenter();
  const d1 = await display();
  const d2 = await display();
  const v = await participant();
  p.send({ t: 'share', on: true });
  for (const c of [p, d1, d2]) {
    const m = await c.next(isShare((x) => x.shown));
    assert.equal(m.url, 'https://slides.example.org/talk/view');
    assert.equal(m.text, 'slides.example.org/talk');
    assert.equal(m.protected, false);
    assert.equal(m.password, null);
  }
  // A screen that connects now shows it too.
  const late = ws('viewer');
  assert.equal((await late.next(isShare())).shown, true);
  // Participants: no message, and no command.
  v.send({ t: 'share', on: false });
  assert.equal((await v.next((m) => m.t === 'error')).code, 'forbidden');
  // A display may not change it either (it does not control).
  d1.send({ t: 'share', on: false });
  assert.equal((await d1.next((m) => m.t === 'error')).code, 'forbidden');
  await sleep(100);
  assert.ok(!v.messages.some((m) => m.t === 'share'));
  // Invalid command.
  p.send({ t: 'share', on: 'yes' });
  assert.equal((await p.next((m) => m.t === 'error')).code, 'bad-message');
  p.send({ t: 'share', on: false });
  assert.equal((await d2.next(isShare())).shown, false);
});

test('the password shows only when the room shows it, only while on the screens', async (t) => {
  const { presenter, display, admin, configOnDisk, ctx } = await setup(t);
  // No copy kept unless the room shows it.
  assert.equal((await admin('PUT', '/api/admin/passwords', { scope: 'deckViewer', deck: 'talk', password: 'class-pass1' })).statusCode, 204);
  assert.equal((await configOnDisk()).decks.talk.viewerClear, undefined);
  const p = await presenter();
  const d = await display();
  p.send({ t: 'share', on: true });
  let m = await d.next(isShare((x) => x.shown));
  assert.equal(m.protected, true);
  assert.equal(m.password, null);
  assert.equal(m.passwordMissing, false);

  // Turned on without the password: the presenter is told it is missing.
  assert.equal((await admin('PATCH', '/api/admin/rooms/talk', { showPassword: true })).statusCode, 200);
  m = await p.next(isShare((x) => x.passwordMissing));
  assert.equal(m.passwordMissing, true);
  assert.equal(m.password, null);
  // Typed once, checked against the hash.
  const wrong = await admin('PUT', '/api/admin/rooms/talk/shown-password', { password: 'nope-nope1' });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error, 'wrong-password');
  assert.equal((await admin('PUT', '/api/admin/rooms/talk/shown-password', { password: 'class-pass1' })).statusCode, 200);
  m = await d.next(isShare((x) => x.password));
  assert.equal(m.password, 'class-pass1');
  assert.equal(m.passwordMissing, false);
  assert.equal((await configOnDisk()).decks.talk.viewerClear, 'class-pass1');
  const rows = (await admin('GET', '/api/admin/decks')).json().decks;
  assert.equal(rows[0].viewerPasswordShown, true);
  assert.ok(!JSON.stringify(rows).includes('class-pass1'), 'never sent back to the panel');

  // A new password reaches the screens; clearing it leaves no password.
  await admin('PUT', '/api/admin/passwords', { scope: 'deckViewer', deck: 'talk', password: 'class-pass2' });
  assert.equal((await d.next(isShare((x) => x.password === 'class-pass2'))).shown, true);
  await admin('PUT', '/api/admin/passwords', { scope: 'deckViewer', deck: 'talk', password: null });
  m = await d.next(isShare((x) => !x.protected));
  assert.equal(m.password, null);
  assert.equal(ctx.config.decks.talk, undefined);
  await admin('PUT', '/api/admin/passwords', { scope: 'deckViewer', deck: 'talk', password: 'class-pass3' });
  assert.equal((await d.next(isShare((x) => x.password))).password, 'class-pass3');

  // Off the screens: the password is not sent.
  p.send({ t: 'share', on: false });
  m = await d.next(isShare((x) => !x.shown));
  assert.equal(m.password, null);
  // Not shown any more: the copy goes from config.json.
  await admin('PATCH', '/api/admin/rooms/talk', { showPassword: false });
  assert.equal((await configOnDisk()).decks.talk.viewerClear, undefined);
  await sleep(50);
  d.messages.length = 0; // only what comes next
  p.send({ t: 'share', on: true });
  m = await d.next(isShare((x) => x.shown));
  assert.equal(m.password, null);
  assert.equal(m.passwordMissing, false);
  // Without a viewer password there is nothing to confirm.
  await admin('PUT', '/api/admin/passwords', { scope: 'deckViewer', deck: 'talk', password: null });
  assert.equal((await admin('PUT', '/api/admin/rooms/talk/shown-password', { password: 'class-pass3' })).statusCode, 409);
});

test('deleting the deck forgets the copy', async (t) => {
  const { admin, configOnDisk, ctx } = await setup(t);
  await admin('PATCH', '/api/admin/rooms/talk', { showPassword: true });
  await admin('PUT', '/api/admin/passwords', { scope: 'deckViewer', deck: 'talk', password: 'class-pass1' });
  assert.equal(ctx.config.decks.talk.viewerClear, 'class-pass1', 'kept: the room shows it');
  assert.equal((await admin('DELETE', '/api/admin/decks/talk')).statusCode, 204);
  assert.equal((await configOnDisk()).decks.talk?.viewerClear, undefined);
});

test('moving the slides, a poll, its results or the ranking take it off; closing the room too', async (t) => {
  const { presenter, display, admin } = await setup(t);
  const p = await presenter();
  const d = await display();
  const on = async () => {
    p.send({ t: 'share', on: true });
    await d.next(isShare((x) => x.shown));
  };
  const off = () => d.next(isShare((x) => !x.shown));
  p.send({ t: 'meta', total: 5 });
  await on();
  p.send({ t: 'blank', on: true }); // blanking only hides it on the screens
  p.send({ t: 'blank', on: false });
  p.send({ t: 'step', delta: 1 });
  await off();
  assert.ok(!d.messages.some(isShare()), 'one message: the step');
  await on();
  p.send({ t: 'poll', action: 'show', slide: 'q' });
  await off();
  p.send({ t: 'poll', action: 'close', slide: 'q', results: false });
  await d.next((m) => m.t === 'polls' && m.runs?.[0]?.open === false);
  await on();
  p.send({ t: 'poll', action: 'reveal', slide: 'q' });
  await off();
  await on();
  await admin('PATCH', '/api/admin/rooms/talk', { open: false });
  await off();
});

test('a screen that lost its presenter rights is closed instead of told', async (t) => {
  const { app, urls, admin, presenter } = await setup(t);
  await app.slidecast.auth.setPassword('presenter', null, 'presenter-pass1');
  const res = await app.inject({ method: 'POST', url: '/api/login', headers: { ...LOCAL, 'x-real-ip': '1.1.1.1' }, payload: { scope: 'presenter', password: 'presenter-pass1' } });
  const cookie = `sc_session=${res.cookies.find((c) => c.name === 'sc_session').value}`;
  // A projector on another device (through a proxy, so not this computer).
  const d = wsClient(`${urls.ws}/ws/talk?role=viewer`, { cookie, headers: PROXIED });
  onCleanup(t, () => d.close());
  await d.next(isShare());
  const p = await presenter();
  await admin('PUT', '/api/admin/passwords', { scope: 'presenter', password: 'presenter-pass2' });
  p.send({ t: 'share', on: true });
  assert.equal((await d.closed).code, 4401);
  assert.ok(!d.messages.some(isShare((x) => x.shown)));
});

test('a screen reached by its public address shows that address', async (t) => {
  const { app, urls } = await setup(t);
  await app.slidecast.auth.setPassword('presenter', null, 'presenter-pass1');
  const headers = { host: 'slides.example.org', origin: 'https://slides.example.org', 'cf-connecting-ip': '203.0.113.7' };
  const res = await app.inject({ method: 'POST', url: '/api/login', headers, payload: { scope: 'presenter', password: 'presenter-pass1' } });
  const cookie = `sc_session=${res.cookies.find((c) => c.name === 'sc_session').value}`;
  const c = wsClient(`${urls.ws}/ws/talk?role=presenter`, { cookie, origin: headers.origin, headers: { Host: headers.host, 'cf-connecting-ip': '203.0.113.7' } });
  onCleanup(t, () => c.close());
  const m = await c.next(isShare());
  assert.equal(m.url, 'https://slides.example.org/talk/view');
  // This computer's own screen, with the server only on loopback: nothing to show.
  const local = wsClient(`${urls.ws}/ws/talk?role=viewer`);
  onCleanup(t, () => local.close());
  assert.equal((await local.next(isShare())).url, null);
});

test('the CLI keeps the copy for a room that shows it, and the running server shows it', async (t) => {
  const { presenter, display, admin, dirs } = await setup(t);
  await admin('PATCH', '/api/admin/rooms/talk', { showPassword: true });
  const p = await presenter();
  const d = await display();
  p.send({ t: 'share', on: true });
  await d.next(isShare((x) => x.shown));
  await sleep(1100); // distinct mtime
  await passwd(['viewer', '--deck', 'talk', '--state', dirs.stateDir], 'from-cli-pass1\n');
  assert.equal((await d.next(isShare((x) => x.password), 8000)).password, 'from-cli-pass1');
});

test('a clear copy the server does not keep is written out of config.json', async (t) => {
  const { admin, configOnDisk, ctx, dirs } = await setup(t);
  await admin('PUT', '/api/admin/passwords', { scope: 'deckViewer', deck: 'talk', password: 'class-pass1' });
  // As if the CLI had read the file while the room still showed the password.
  const fresh = await configOnDisk();
  fresh.decks.talk.viewerClear = 'class-pass1';
  fresh.writeId = 'from-the-cli';
  await writeFile(join(dirs.stateDir, 'config.json'), JSON.stringify(fresh));
  await ctx.configFileChanged(fresh);
  assert.equal(ctx.config.decks.talk.viewerClear, undefined);
  assert.equal((await configOnDisk()).decks.talk.viewerClear, undefined);
});
