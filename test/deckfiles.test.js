import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, link } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildServer } from '../src/server.js';
import { issueDeckToken, verifyDeckToken } from '../src/tokens.js';
import { onCleanup, tempDirs } from './helpers.js';

const CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'";

async function setup(t) {
  const dirs = await tempDirs(t);
  for (const slug of ['talk', 'other']) {
    await mkdir(join(dirs.dataDir, slug, 'img'), { recursive: true });
    await writeFile(join(dirs.dataDir, slug, 'index.html'),
      '<!doctype html><html lang="en"><HEAD data-x="1"><title>T</title><script>var a=1</script></head><body>hi</body></html>');
    await writeFile(join(dirs.dataDir, slug, 'deck.json'), '{"syncdeck":1}');
    await writeFile(join(dirs.dataDir, slug, 'img', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  }
  await writeFile(join(dirs.root, 'secret.txt'), 'TOP SECRET');
  const app = await buildServer(dirs);
  onCleanup(t, () => app.close());
  const token = (slug = 'talk', now) => issueDeckToken(app.syncdeck.config.secret, slug, now);
  return { app, token, ...dirs };
}

test('index.html gets the bridge first in <head> and the sandbox CSP', async (t) => {
  const { app, token } = await setup(t);
  const res = await app.inject(`/_deck/talk/${token()}/`);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<HEAD data-x="1"><script src="\/_syncdeck\/bridge\.js"><\/script><title>/);
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  const same = await app.inject(`/_deck/talk/${token()}/index.html`);
  assert.equal(same.body, res.body);
});

test('assets are served with type, etag and the sandbox CSP', async (t) => {
  const { app, token } = await setup(t);
  const res = await app.inject(`/_deck/talk/${token()}/img/a.svg`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/svg+xml');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'private, max-age=3600');
  assert.equal(res.headers['content-security-policy'], CSP);
  const again = await app.inject({ url: `/_deck/talk/${token()}/img/a.svg`, headers: { 'if-none-match': res.headers.etag } });
  assert.equal(again.statusCode, 304);
});

test('traversal attempts never read outside the deck', async (t) => {
  const { app, token } = await setup(t);
  for (const p of ['../../secret.txt', '%2e%2e/%2e%2e/secret.txt', '%2e%2e%2f%2e%2e%2fsecret.txt',
    '..%2f..%2fsecret.txt', 'img/..%2f..%2f..%2fsecret.txt', '%2e%2e%5c%2e%2e%5csecret.txt']) {
    const res = await app.inject(`/_deck/talk/${token()}/${p}`);
    assert.ok([403, 404].includes(res.statusCode), `${p} → ${res.statusCode}`);
    assert.doesNotMatch(res.body, /TOP SECRET/);
  }
});

test('expired, malformed and other-deck tokens are refused', async (t) => {
  const { app, token } = await setup(t);
  const expired = token('talk', Date.now() - 8 * 24 * 3600 * 1000);
  assert.equal((await app.inject(`/_deck/talk/${expired}/`)).statusCode, 403);
  assert.equal((await app.inject(`/_deck/talk/${token('other')}/`)).statusCode, 403);
  assert.equal((await app.inject('/_deck/talk/123.abc/')).statusCode, 403);
  assert.equal(verifyDeckToken('s', 'talk', issueDeckToken('s', 'talk')), true);
  assert.equal(verifyDeckToken('s2', 'talk', issueDeckToken('s', 'talk')), false);
});

test('deck.json is never served', async (t) => {
  const { app, token } = await setup(t);
  assert.equal((await app.inject(`/_deck/talk/${token()}/deck.json`)).statusCode, 404);
});

test('deck.json is not served under another name either', async (t) => {
  const { app, token, dataDir } = await setup(t);
  // Case-insensitive file systems (macOS, Windows) open deck.json for these.
  for (const name of ['DECK.JSON', 'Deck.json', 'deck.json.', 'deck.json%3A%3A%24DATA']) {
    await writeFile(join(dataDir, 'talk', decodeURIComponent(name)), '{"syncdeck":1}');
    assert.equal((await app.inject(`/_deck/talk/${token()}/${name}`)).statusCode, 404, name);
  }
  // Any other link to the same file, such as a Windows short name.
  await link(join(dataDir, 'talk', 'deck.json'), join(dataDir, 'talk', 'notes.json'));
  assert.equal((await app.inject(`/_deck/talk/${token()}/notes.json`)).statusCode, 404);
});

test('hidden files and folders are never served', async (t) => {
  const { app, token, dataDir } = await setup(t);
  await mkdir(join(dataDir, 'talk', '.syncdeck'));
  await writeFile(join(dataDir, 'talk', '.syncdeck', 'config.json'), '{"secret":"s"}');
  await writeFile(join(dataDir, 'talk', '.env'), 'KEY=1');
  await mkdir(join(dataDir, 'talk', 'img', '.git'));
  await writeFile(join(dataDir, 'talk', 'img', '.git', 'config'), 'x');
  for (const p of ['.syncdeck/config.json', '.env', 'img/.git/config', '%2esyncdeck/config.json', '.syncdeck%5cconfig.json']) {
    assert.equal((await app.inject(`/_deck/talk/${token()}/${p}`)).statusCode, 404, p);
  }
});

test('tokens expiring later than the server ever issues are refused', async () => {
  assert.equal(verifyDeckToken('s', 'talk', issueDeckToken('s', 'talk', Date.now() + 3600_000)), false);
  assert.equal(verifyDeckToken('s', 'talk', issueDeckToken('s', 'talk', Date.now() + 60_000)), true);
});

test('index.html is built once per version and answers 304 to its ETag', async (t) => {
  const { app, token, dataDir } = await setup(t);
  const url = `/_deck/talk/${token()}/`;
  const first = await app.inject(url);
  const etag = first.headers.etag;
  assert.ok(etag);
  assert.equal((await app.inject({ url, headers: { 'if-none-match': etag } })).statusCode, 304);
  await writeFile(join(dataDir, 'talk', 'index.html'), '<!doctype html><html><head></head><body>changed</body></html>');
  const after = await app.inject({ url, headers: { 'if-none-match': etag } });
  assert.equal(after.statusCode, 200);
  assert.match(after.body, /changed/);
  assert.match(after.body, /bridge\.js/);
});

test('gzip when the client accepts it', async (t) => {
  const { app, token } = await setup(t);
  const res = await app.inject({ url: `/_deck/talk/${token()}/`, headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(res.rawPayload).toString(), /bridge\.js/);
  const svg = await app.inject({ url: `/_deck/talk/${token()}/img/a.svg`, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(svg.headers['content-encoding'], 'gzip');
});

test('injectBridge without <head> keeps the doctype first', async () => {
  const { injectBridge } = await import('../src/deckfiles.js');
  assert.match(injectBridge('<!DOCTYPE html><p>x'), /^<!DOCTYPE html><script src/);
  assert.match(injectBridge('<html><body>x'), /^<html><script src/);
  assert.match(injectBridge('<p>x'), /^<script src/);
  assert.match(injectBridge('<header>x</header>'), /^<script src/);
});
