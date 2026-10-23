import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { hashPassword, verifyPassword, isLocalDirect, revokeScope } from '../src/auth.js';
import { onCleanup, tempDirs, makeDeck } from './helpers.js';

const HOST = 'syncdeck.test';
const ORIGIN = `http://${HOST}`;

async function setup(t, { trustProxy = false } = {}) {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk');
  const app = await buildServer({ ...dirs, trustProxy });
  onCleanup(t, () => app.close());
  const auth = app.syncdeck.auth;
  return { app, auth, dirs };
}

// app.inject comes from 127.0.0.1 with no proxy headers: "local direct".
function login(app, body, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

const cookieOf = (res) => {
  const c = res.cookies.find((x) => x.name === 'sd_session');
  return c && `sd_session=${c.value}`;
};

test('hashes use scrypt and verify in constant-time compare', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.notEqual(await hashPassword('correct horse'), h, 'salted');
});

test('correct password sets a HttpOnly, Lax, non-Secure cookie over HTTP', async (t) => {
  const { app, auth, dirs } = await setup(t);
  await auth.setPassword('presenter', null, 'presenter-pass');
  const res = await login(app, { scope: 'presenter', password: 'presenter-pass' });
  assert.equal(res.statusCode, 204);
  const c = res.cookies.find((x) => x.name === 'sd_session');
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Lax');
  assert.equal(c.path, '/');
  assert.equal(c.secure, undefined);
  assert.equal(c.value.length, 43);
  const session = await app.inject({ url: '/api/session', headers: { cookie: cookieOf(res) } });
  assert.deepEqual(session.json().present, ['*']);
  // Only the SHA-256 of the cookie is stored.
  await auth.close();
  const stored = await readFile(join(dirs.stateDir, 'sessions.json'), 'utf8');
  assert.ok(!stored.includes(c.value));
  assert.match(Object.keys(JSON.parse(stored))[0], /^[0-9a-f]{64}$/);
});

test('with trustProxy and X-Forwarded-Proto https the cookie is Secure', async (t) => {
  const { app, auth } = await setup(t, { trustProxy: true });
  await auth.setPassword('admin', null, 'admin-password');
  const res = await login(app, { scope: 'admin', password: 'admin-password' }, { 'x-forwarded-proto': 'https' });
  assert.equal(res.statusCode, 204);
  assert.equal(res.cookies.find((x) => x.name === 'sd_session').secure, true);
  // Without trustProxy the header is ignored.
  const plain = await setup(t);
  await plain.auth.setPassword('admin', null, 'admin-password');
  const res2 = await login(plain.app, { scope: 'admin', password: 'admin-password' }, { 'x-forwarded-proto': 'https' });
  assert.equal(res2.cookies.find((x) => x.name === 'sd_session').secure, undefined);
});

test('wrong password → 401, the 6th attempt in a minute → 429', async (t) => {
  const { app, auth } = await setup(t);
  await auth.setPassword('admin', null, 'admin-password');
  for (let i = 0; i < 5; i++) {
    const res = await login(app, { scope: 'admin', password: `nope-${i}` });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'bad-password' });
  }
  const sixth = await login(app, { scope: 'admin', password: 'admin-password' });
  assert.equal(sixth.statusCode, 429);
  assert.ok(Number(sixth.headers['retry-after']) > 0);
});

test('the global limit caps logins from many addresses', async (t) => {
  const { app, auth } = await setup(t, { trustProxy: true });
  await auth.setPassword('admin', null, 'admin-password');
  const codes = [];
  for (let i = 0; i < 51; i++) {
    codes.push((await login(app, { scope: 'admin', password: 'x' }, { 'cf-connecting-ip': `198.51.100.${i}` })).statusCode);
  }
  assert.deepEqual([...new Set(codes.slice(0, 50))], [401]);
  assert.equal(codes[50], 429);
});

test('changing the presenter password revokes presenter sessions', async (t) => {
  const { app, auth } = await setup(t);
  await auth.setPassword('presenter', null, 'presenter-pass');
  const cookie = cookieOf(await login(app, { scope: 'presenter', password: 'presenter-pass' }));
  const proxied = { cookie, 'cf-connecting-ip': '203.0.113.1', host: HOST };
  const req = (c) => ({ cookies: { sd_session: c.split('=')[1] }, headers: proxied, raw: { socket: { remoteAddress: '127.0.0.1' } } });
  assert.equal(auth.canPresent(req(cookie), 'talk'), true);
  await auth.setPassword('presenter', null, 'another-pass');
  assert.equal(auth.canPresent(req(cookie), 'talk'), false);
  const s = await app.inject({ url: '/api/session', headers: { cookie } });
  assert.deepEqual(s.json().present, []);
});

test('a deck password overrides a global presenter session', async (t) => {
  const { app, auth } = await setup(t);
  await auth.setPassword('presenter', null, 'presenter-pass');
  const cookie = cookieOf(await login(app, { scope: 'presenter', password: 'presenter-pass' }));
  const req = { cookies: { sd_session: cookie.split('=')[1] }, headers: { 'x-forwarded-for': '1.2.3.4' }, raw: { socket: { remoteAddress: '127.0.0.1' } } };
  assert.equal(auth.canPresent(req, 'talk'), true);
  await auth.setPassword('deckPresenter', 'talk', 'deck-only-pass');
  assert.equal(auth.canPresent(req, 'talk'), false);
  assert.equal((await login(app, { scope: 'presenter', deck: 'talk', password: 'presenter-pass' })).statusCode, 401);
  assert.equal((await login(app, { scope: 'presenter', deck: 'talk', password: 'deck-only-pass' })).statusCode, 204);
});

test('local-direct rule: loopback without proxy headers only', async (t) => {
  const { app, auth } = await setup(t);
  const base = { raw: { socket: { remoteAddress: '127.0.0.1' } }, headers: {}, cookies: {} };
  assert.equal(isLocalDirect(base), true);
  assert.equal(isLocalDirect({ ...base, raw: { socket: { remoteAddress: '::ffff:127.0.0.1' } } }), true);
  assert.equal(isLocalDirect({ ...base, raw: { socket: { remoteAddress: '192.168.1.10' } } }), false);
  for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip']) {
    assert.equal(isLocalDirect({ ...base, headers: { [h]: '203.0.113.5' } }), false, h);
  }
  assert.equal(auth.canPresent(base, 'talk'), true);
  assert.equal(auth.canAdmin(base), true);
  const proxied = { ...base, headers: { 'cf-connecting-ip': '203.0.113.5' } };
  assert.equal(auth.canPresent(proxied, 'talk'), false);
  assert.equal(auth.canAdmin(proxied), false);
  // No password configured: login answers 409 whatever the address.
  const res = await login(app, { scope: 'presenter', password: 'whatever1' }, { 'cf-connecting-ip': '203.0.113.5' });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'no-password-configured' });
  const s = await app.inject({ url: '/api/session', headers: { 'cf-connecting-ip': '203.0.113.5' } });
  assert.deepEqual(s.json(), { admin: false, present: [], view: [], localDirect: false });
});

test('POST without a matching Origin → 403', async (t) => {
  const { app } = await setup(t);
  const base = { method: 'POST', url: '/api/login', payload: { scope: 'admin', password: 'x' } };
  for (const origin of [undefined, 'http://evil.example', 'null', 'http://syncdeck.test.evil.example']) {
    const headers = { host: HOST, 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    const res = await app.inject({ ...base, headers });
    assert.equal(res.statusCode, 403, String(origin));
  }
  const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: { host: HOST } });
  assert.equal(logout.statusCode, 403);
});

test('text/plain bodies are not accepted', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST', url: '/api/login', headers: { host: HOST, origin: ORIGIN, 'content-type': 'text/plain' },
    payload: JSON.stringify({ scope: 'admin', password: 'x' }),
  });
  assert.equal(res.statusCode, 415);
});

test('login rotates the session id and keeps earlier scopes', async (t) => {
  const { app, auth } = await setup(t);
  await auth.setPassword('admin', null, 'admin-password');
  await auth.setPassword('deckViewer', 'talk', 'viewer-pass');
  const first = cookieOf(await login(app, { scope: 'viewer', deck: 'talk', password: 'viewer-pass' }));
  const second = cookieOf(await login(app, { scope: 'admin', password: 'admin-password' }, { cookie: first }));
  assert.notEqual(first, second);
  assert.deepEqual((await app.inject({ url: '/api/session', headers: { cookie: first } })).json().view, []);
  const s = (await app.inject({ url: '/api/session', headers: { cookie: second, 'x-real-ip': '1.1.1.1' } })).json();
  assert.equal(s.admin, true);
  assert.deepEqual(s.view, ['talk']);
});

test('logout clears the session', async (t) => {
  const { app, auth } = await setup(t);
  await auth.setPassword('admin', null, 'admin-password');
  const cookie = cookieOf(await login(app, { scope: 'admin', password: 'admin-password' }));
  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { host: HOST, origin: ORIGIN, cookie } });
  assert.equal(out.statusCode, 204);
  const s = await app.inject({ url: '/api/session', headers: { cookie, 'x-real-ip': '1.1.1.1' } });
  assert.equal(s.json().admin, false);
});

test('revokeScope drops global-presenter grants but keeps deck-password grants', () => {
  const config = { decks: { own: { presenterHash: 'h' } } };
  const sessions = {
    a: { admin: false, present: ['*', 'plain', 'own'], view: [] },
    b: { admin: false, present: ['*'], view: [] },
  };
  revokeScope(sessions, config, 'presenter');
  assert.deepEqual(sessions.a.present, ['own']);
  assert.equal(sessions.b, undefined, 'empty session removed');
});

test('a running server picks up a password changed by the CLI and revokes sessions', async (t) => {
  const { app, auth, dirs } = await setup(t);
  await auth.setPassword('presenter', null, 'presenter-pass');
  const cookie = cookieOf(await login(app, { scope: 'presenter', password: 'presenter-pass' }));
  const { loadConfig, saveConfig } = await import('../src/config.js');
  const { applyPasswordHash } = await import('../src/auth.js');
  // What `syncdeck passwd presenter` does, from another process.
  await new Promise((r) => setTimeout(r, 1100)); // distinct mtime
  const onDisk = await loadConfig(dirs.stateDir);
  applyPasswordHash(onDisk, 'presenter', null, await hashPassword('changed-by-cli'));
  await saveConfig(dirs.stateDir, onDisk);
  const remote = { cookie, 'x-real-ip': '1.1.1.1' };
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 40; i++) {
      const s = (await app.inject({ url: '/api/session', headers: remote })).json();
      if (s.present.length === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('session not revoked');
  });
  assert.equal((await login(app, { scope: 'presenter', password: 'changed-by-cli' })).statusCode, 204);
});

test('20 failed logins in an hour lock that address out, and failures are logged', async (t) => {
  const dirs = await tempDirs(t);
  await makeDeck(dirs.dataDir, 'talk');
  const lines = [];
  const stream = { write: (s) => lines.push(JSON.parse(s)) };
  const app = await buildServer({
    ...dirs, trustProxy: true, logger: { level: 'warn', stream }, loginLimits: { perMinute: 100 },
  });
  onCleanup(t, () => app.close());
  await app.syncdeck.auth.setPassword('admin', null, 'admin-password1');
  const ip = { 'cf-connecting-ip': '203.0.113.50' };
  for (let i = 0; i < 20; i++) {
    assert.equal((await login(app, { scope: 'admin', password: `wrong-guess-${i}` }, ip)).statusCode, 401);
  }
  const locked = await login(app, { scope: 'admin', password: 'admin-password1' }, ip);
  assert.equal(locked.statusCode, 429);
  assert.ok(Number(locked.headers['retry-after']) > 60);
  // Another address is not affected.
  const other = await login(app, { scope: 'admin', password: 'admin-password1' }, { 'cf-connecting-ip': '203.0.113.51' });
  assert.equal(other.statusCode, 204);
  const failed = lines.filter((l) => l.msg === 'login failed');
  assert.equal(failed.length, 20);
  assert.deepEqual({ ip: failed[0].ip, scope: failed[0].scope }, { ip: '203.0.113.50', scope: 'admin' });
  assert.ok(lines.some((l) => l.msg === 'login locked' && l.ip === '203.0.113.50'));
  assert.ok(!JSON.stringify(lines).includes('wrong-guess'));
});

test('passwords need a letter and a digit', async () => {
  const { checkPasswordInput } = await import('../src/auth.js');
  assert.equal(checkPasswordInput('abcdefgh'), 'password-too-weak');
  assert.equal(checkPasswordInput('12345678'), 'password-too-weak');
  assert.equal(checkPasswordInput('abc123'), 'password-too-short');
  assert.equal(checkPasswordInput('abcd1234'), null);
  assert.equal(checkPasswordInput('contraseña9'), null);
});
