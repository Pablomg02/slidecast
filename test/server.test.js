import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { onCleanup, tempDirs } from './helpers.js';

test('GET /health answers ok', async (t) => {
  const { dataDir, stateDir } = await tempDirs(t);
  const app = await buildServer({ dataDir, stateDir });
  onCleanup(t, () => app.close());
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});
