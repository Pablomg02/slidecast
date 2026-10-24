import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, stat, cp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDirs, onCleanup } from './helpers.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(repo, 'bin', 'slidecast.js');

function run(args, { input, cwd = repo, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { cwd, env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const config = async (stateDir) => JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));

test('passwd admin from stdin stores a scrypt hash', async (t) => {
  const { stateDir } = await tempDirs(t);
  const r = await run(['passwd', 'admin', '--state', stateDir], { input: 'password123\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.match((await config(stateDir)).adminHash, /^scrypt\$/);
  assert.match(r.stdout, /Admin password set/);
});

test('passwd rejects short passwords and bad usage', async (t) => {
  const { stateDir } = await tempDirs(t);
  const short = await run(['passwd', 'admin', '--state', stateDir], { input: 'short\n' });
  assert.equal(short.code, 1);
  assert.match(short.stderr, /8 characters/);
  const weak = await run(['passwd', 'admin', '--state', stateDir], { input: 'passwords\n' });
  assert.equal(weak.code, 1);
  assert.match(weak.stderr, /one letter and one digit/);
  const bad = await run(['passwd', 'admin', '--viewer', '--state', stateDir], { input: 'password123\n' });
  assert.equal(bad.code, 1);
});

test('passwd presenter --deck sets and --clear clears; sessions are revoked', async (t) => {
  const { stateDir } = await tempDirs(t);
  await run(['passwd', 'presenter', '--deck', 'demo', '--state', stateDir], { input: 'deckpass123\n' });
  assert.match((await config(stateDir)).decks.demo.presenterHash, /^scrypt\$/);
  await run(['passwd', 'presenter', '--deck', 'demo', '--viewer', '--state', stateDir], { input: 'viewpass123\n' });
  assert.match((await config(stateDir)).decks.demo.viewerHash, /^scrypt\$/);
  const { writeFile } = await import('node:fs/promises');
  const id = 'a'.repeat(64);
  const now = Date.now();
  await writeFile(join(stateDir, 'sessions.json'), JSON.stringify({ [id]: { admin: false, present: ['demo'], view: [], created: now, lastSeen: now } }));
  const r = await run(['passwd', 'presenter', '--deck', 'demo', '--clear', '--state', stateDir]);
  assert.equal(r.code, 0, r.stderr);
  const c = await config(stateDir);
  assert.equal(c.decks.demo.presenterHash, null);
  assert.match(c.decks.demo.viewerHash, /^scrypt\$/);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'sessions.json'), 'utf8')), {});
});

test('new creates a deck from the demo', async (t) => {
  const { dataDir } = await tempDirs(t);
  const r = await run(['new', 'demo2', '--data', dataDir]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok((await stat(join(dataDir, 'demo2', 'index.html'))).isFile());
  assert.equal(JSON.parse(await readFile(join(dataDir, 'demo2', 'deck.json'), 'utf8')).title, 'demo2');
  assert.equal((await run(['new', 'demo2', '--data', dataDir])).code, 1);
  assert.equal((await run(['new', 'Bad Name', '--data', dataDir])).code, 1);
});

test('--help and --version', async () => {
  assert.match((await run(['--help'])).stdout, /slidecast serve \[path\]/);
  assert.match((await run(['--version'])).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal((await run(['nope'])).code, 1);
});

function serve(args, t, { cwd = repo, env } = {}) {
  const child = spawn(process.execPath, [BIN, 'serve', ...args], { cwd, env });
  onCleanup(t, () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }));
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /Admin: (http:\/\/[^/]+)\/admin/.exec(out);
      if (m) resolve({ base: m[1], out });
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
  });
}

test('serve examples/demo redirects / to /demo', async (t) => {
  const { stateDir } = await tempDirs(t);
  const { base, out } = await serve(['examples/demo', '--port', '0', '--state', stateDir], t);
  assert.match(out, /Single deck: .*examples\/demo/);
  assert.match(out, /Open: {2}http:\/\/127\.0\.0\.1:\d+\/demo/);
  const res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/demo');
  assert.equal((await fetch(`${base}/demo`)).status, 200);
});

test('serve on 0.0.0.0 lists LAN URLs and warns about missing passwords', async (t) => {
  const { stateDir, dataDir } = await tempDirs(t);
  const { out } = await serve([dataDir, '--host', '0.0.0.0', '--port', '0', '--state', stateDir], t);
  assert.match(out, /Warning: listening on 0\.0\.0\.0 with no presenter or admin password/);
  assert.match(out, /slidecast passwd presenter --state /);
});

test('from inside a deck folder the state goes to the user config folder, not into the deck', async (t) => {
  const { root } = await tempDirs(t);
  const deck = join(root, 'my-talk');
  await cp(join(repo, 'examples', 'demo'), deck, { recursive: true });
  await mkdir(join(deck, '.slidecast'));
  await writeFile(join(deck, '.slidecast', 'config.json'), JSON.stringify({ secret: 'old-secret' }));
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'xdg') };
  delete env.SLIDECAST_STATE;
  const userState = join(root, 'xdg', 'slidecast');

  const r = await run(['passwd', 'admin'], { input: 'password123\n', cwd: deck, env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /moved the state folder out of the deck/);
  assert.equal(existsSync(join(deck, '.slidecast')), false);
  const c = await config(userState);
  assert.equal(c.secret, 'old-secret');
  assert.match(c.adminHash, /^scrypt\$/);

  const { base } = await serve(['.', '--port', '0'], t, { cwd: deck, env });
  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.admin, false, 'the admin password from the user folder applies');
  assert.equal(existsSync(join(deck, '.slidecast')), false);
});
