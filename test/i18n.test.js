import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// i18n.js reads navigator at import time (Node 20 has none), so its strings
// are read from the source: `  en: {` … `  },` holds `    key: '…',` lines.
async function strings() {
  const src = await readFile(join(repo, 'public', 'i18n.js'), 'utf8');
  const out = {};
  for (const [, lang, body] of src.matchAll(/^ {2}(\w+): \{\n([\s\S]*?)^ {2}\},/gm)) {
    out[lang] = Object.fromEntries(
      [...body.matchAll(/^ {4}(\w+): (['"])(.*)\2,$/gm)].map(([, k, , v]) => [k, v]),
    );
  }
  return out;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every shipped language has every English string, with the same placeholders', async () => {
  const all = await strings();
  const { en } = all;
  assert.ok(Object.keys(en).length > 50, 'parsed the English strings');
  const languages = Object.keys(all).filter((l) => l !== 'en');
  assert.ok(languages.length >= 2, `expected at least two translations, got ${languages.join(', ')}`);
  for (const lang of languages) {
    assert.deepEqual(Object.keys(all[lang]).sort(), Object.keys(en).sort(),
      `${lang} is missing strings or carries extras`);
    for (const k of Object.keys(en)) {
      assert.deepEqual(placeholders(all[lang][k]), placeholders(en[k]), `placeholders of ${lang}.${k}`);
    }
  }
});
