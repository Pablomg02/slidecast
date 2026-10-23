import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the native API example in docs/deck-format.md is the demo deck code', async () => {
  const demo = await readFile(join(repo, 'examples', 'demo', 'index.html'), 'utf8');
  const doc = await readFile(join(repo, 'docs', 'deck-format.md'), 'utf8');
  const start = demo.indexOf('// --- syncdeck native deck API');
  const end = demo.indexOf('\n', demo.indexOf('// --- end of the deck API'));
  const fromDemo = demo.slice(start, end);
  const m = /<!-- demo-api:start -->\n```js\n([\s\S]*?)\n```\n<!-- demo-api:end -->/.exec(doc);
  assert.ok(m, 'doc has the demo-api block');
  assert.equal(m[1], fromDemo);
});
