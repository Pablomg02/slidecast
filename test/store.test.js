import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { tempDirs } from './helpers.js';

test('concurrent atomic writes leave one valid value and no temp files', async (t) => {
  const { root } = await tempDirs(t);
  const path = join(root, 'x.json');
  const values = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'x'.repeat(i * 100) }));
  await Promise.all(values.map((v) => writeJsonAtomic(path, v)));
  const got = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(values.some((v) => v.i === got.i && v.pad === got.pad));
  const files = await readdir(root);
  assert.equal(files.filter((f) => f.includes('.tmp-')).length, 0);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('readJson returns the fallback for a missing file', async (t) => {
  const { root } = await tempDirs(t);
  assert.deepEqual(await readJson(join(root, 'nope.json'), { a: 1 }), { a: 1 });
});

test('loadConfig creates a private config with a stable secret', async (t) => {
  const { stateDir } = await tempDirs(t);
  const first = await loadConfig(stateDir);
  const st = await stat(join(stateDir, 'config.json'));
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal(first.secret.length, 43);
  const second = await loadConfig(stateDir);
  assert.equal(second.secret, first.secret);
  assert.equal(second.adminHash, null);
  assert.equal(second.publicListing, false);
});
