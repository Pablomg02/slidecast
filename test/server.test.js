import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { onCleanup, tempDirs, makeDeck, passwd } from './helpers.js';

async function serverWithDeck(t) {
  const { dataDir, stateDir } = await tempDirs(t);
  await makeDeck(dataDir, 'talk');
  const app = await buildServer({ dataDir, stateDir });
  onCleanup(t, () => app.close());
  const file = async () => JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
  return { app, ctx: app.slidecast, stateDir, file };
}

// The server polls config.json for the CLI's changes, and the poll also sees
// the server's own writes: it may read one after a newer change in memory.
test('config.json: an older write of the server read back late undoes nothing', async (t) => {
  const { ctx, file } = await serverWithDeck(t);
  await ctx.rooms.update('talk', { open: false });
  const older = await file();
  await ctx.rooms.update('talk', { open: true });
  await ctx.auth.setPassword('admin', null, 'admin-password1');
  await ctx.configFileChanged(older);
  assert.equal(ctx.rooms.settings('talk').open, true);
  assert.match(ctx.config.adminHash, /^scrypt\$/);
});

test('config.json: slidecast passwd while the server runs brings its password, and nothing else', async (t) => {
  const { app, ctx, stateDir, file } = await serverWithDeck(t);
  await ctx.auth.setPassword('admin', null, 'admin-password1');
  const login = await app.inject({
    method: 'POST', url: '/api/login',
    headers: { host: 'slidecast.test', origin: 'http://slidecast.test', 'cf-connecting-ip': '203.0.113.7' },
    payload: { scope: 'admin', password: 'admin-password1' },
  });
  assert.equal(login.statusCode, 204);
  assert.equal(Object.values(ctx.auth.sessions).some((s) => s.admin), true);
  await ctx.rooms.update('talk', { open: false });
  await passwd(['admin', '--state', stateDir], 'cli-password1\n');
  const fromCli = await file();
  // The room opened before the poll read the CLI's file.
  await ctx.rooms.update('talk', { open: true });
  await ctx.configFileChanged(fromCli);
  assert.equal(ctx.config.adminHash, fromCli.adminHash);
  assert.equal(ctx.rooms.settings('talk').open, true);
  assert.equal(Object.values(ctx.auth.sessions).some((s) => s.admin), false, 'admin sessions revoked');
});

test('config.json: a password cleared with the CLI after the panel set it is cleared, though the file reads as before', async (t) => {
  const { ctx, stateDir, file } = await serverWithDeck(t);
  await ctx.rooms.update('talk', { open: true });
  await ctx.auth.setPassword('deckViewer', 'talk', 'viewer-password1');
  await passwd(['presenter', '--deck', 'talk', '--viewer', '--clear', '--state', stateDir]);
  await ctx.configFileChanged(await file());
  assert.equal(ctx.config.decks.talk, undefined);
});

test('GET /health answers ok', async (t) => {
  const { dataDir, stateDir } = await tempDirs(t);
  const app = await buildServer({ dataDir, stateDir });
  onCleanup(t, () => app.close());
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});
