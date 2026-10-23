import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createDeckStore, isValidSlug } from '../src/decks.js';
import { tempDirs } from './helpers.js';

const html = (title) => strToU8(`<!doctype html><html><head><title>${title}</title></head><body></body></html>`);

async function setup(t) {
  const dirs = await tempDirs(t);
  return { ...dirs, store: createDeckStore(dirs) };
}

async function allFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath ?? e.path, e.name));
  }
  return out;
}

test('zip with a single top-level folder is stripped', async (t) => {
  const { store, dataDir } = await setup(t);
  const zip = zipSync({ 'my-deck/index.html': html('Hello &amp; bye'), 'my-deck/img/a.png': new Uint8Array([1, 2]) });
  await store.upload('talk', Buffer.from(zip), 'zip');
  assert.ok((await stat(join(dataDir, 'talk', 'index.html'))).isFile());
  assert.ok((await stat(join(dataDir, 'talk', 'img', 'a.png'))).isFile());
  const [d] = await store.list();
  assert.equal(d.slug, 'talk');
  assert.equal(d.title, 'Hello & bye');
});

for (const [label, name] of [['parent', '../x'], ['absolute', '/abs'], ['backslash', 'a\\b']]) {
  test(`zip entry with ${label} path is rejected`, async (t) => {
    const { store, root } = await setup(t);
    const zip = zipSync({ 'index.html': html('x'), [name]: strToU8('evil') });
    await assert.rejects(store.upload('talk', Buffer.from(zip), 'zip'), { code: 'ERR_ZIP' });
    const files = await allFiles(root);
    assert.deepEqual(files, [], `nothing written, got ${files}`);
  });
}

test('zip symlink entry is rejected', async (t) => {
  const { store, root } = await setup(t);
  const zip = zipSync({
    'index.html': html('x'),
    link: [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
  });
  await assert.rejects(store.upload('talk', Buffer.from(zip), 'zip'), { code: 'ERR_ZIP' });
  assert.deepEqual(await allFiles(root), []);
});

test('zip whose declared size is a lie cannot inflate past it', async (t) => {
  const { store } = await setup(t);
  const zip = Buffer.from(zipSync({ 'index.html': new Uint8Array(100_000) }));
  // Patch the central directory's uncompressed size down to 10 bytes.
  const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(10, cd + 24);
  await assert.rejects(store.upload('talk', zip, 'zip'), { code: 'ERR_ZIP' });
});

test('zip without index.html is rejected', async (t) => {
  const { store } = await setup(t);
  const zip = zipSync({ 'a/index.html': html('x'), 'b/other.html': html('y') });
  await assert.rejects(store.upload('talk', Buffer.from(zip), 'zip'), { code: 'ERR_NO_INDEX' });
});

test('re-upload keeps deck.json and moves the old folder to trash', async (t) => {
  const { store, dataDir, stateDir } = await setup(t);
  await store.upload('talk', Buffer.from(html('v1')), 'html');
  await store.updateSlide('talk', 'intro', { notes: 'keep me' });
  await store.upload('talk', Buffer.from(zipSync({ 'index.html': html('v2') })), 'zip');
  const meta = JSON.parse(await readFile(join(dataDir, 'talk', 'deck.json'), 'utf8'));
  assert.equal(meta.slides.intro.notes, 'keep me');
  const trash = await readdir(join(stateDir, 'trash'));
  assert.equal(trash.length, 1);
  assert.match(trash[0], /^talk-\d{4}-/);
  assert.match(await readFile(join(stateDir, 'trash', trash[0], 'index.html'), 'utf8'), /v1/);
  assert.equal((await store.get('talk')).title, 'v2');
});

test('remove moves the deck to trash', async (t) => {
  const { store, dataDir, stateDir } = await setup(t);
  await store.upload('talk', Buffer.from(html('x')), 'html');
  const to = await store.remove('talk');
  assert.match(to, /trash[/\\]talk-\d{4}-\d\d-\d\dT/);
  await assert.rejects(stat(join(dataDir, 'talk')));
  assert.equal((await readdir(join(stateDir, 'trash'))).length, 1);
  assert.equal(await store.get('talk'), null);
});

test('reserved and invalid slugs are rejected', async (t) => {
  const { store } = await setup(t);
  for (const slug of ['admin', 'api', 'ws', '_deck', 'health', 'Bad', '-x', 'a/b', '', 'x'.repeat(64)]) {
    assert.equal(isValidSlug(slug), false, slug);
    await assert.rejects(store.upload(slug, Buffer.from(html('x')), 'html'), { code: 'ERR_BAD_SLUG' });
  }
  assert.equal(isValidSlug('my-talk-2'), true);
});

test('updateSlide preserves unknown fields', async (t) => {
  const { store, dataDir } = await setup(t);
  await store.upload('talk', Buffer.from(html('x')), 'html');
  await writeFile(join(dataDir, 'talk', 'deck.json'), JSON.stringify({
    syncdeck: 1, extra: 1, slides: { intro: { notes: 'old', extra: 1 } },
  }));
  await store.updateSlide('talk', 'intro', { notes: 'new', steps: { 2: 'step two' } });
  const meta = JSON.parse(await readFile(join(dataDir, 'talk', 'deck.json'), 'utf8'));
  assert.equal(meta.extra, 1);
  assert.equal(meta.slides.intro.extra, 1);
  assert.equal(meta.slides.intro.notes, 'new');
  assert.deepEqual(meta.slides.intro.steps, { 2: 'step two' });
  assert.equal(meta.viewerNav, 'back');
  assert.equal(meta.aspect, '16:9');
});

test('updateSettings validates values', async (t) => {
  const { store } = await setup(t);
  await store.upload('talk', Buffer.from(html('x')), 'html');
  await assert.rejects(store.updateSettings('talk', { viewerNav: 'nope' }), { code: 'ERR_BAD_INPUT' });
  await assert.rejects(store.updateSettings('talk', { aspect: 'wide' }), { code: 'ERR_BAD_INPUT' });
  const meta = await store.updateSettings('talk', { title: 'T', viewerNav: 'free', aspect: '4:3' });
  assert.equal(meta.title, 'T');
  assert.equal((await store.get('talk')).title, 'T');
});

test('list ignores invalid folders and folders without index.html', async (t) => {
  const { store, dataDir } = await setup(t);
  await mkdir(join(dataDir, 'Not Valid'));
  await writeFile(join(dataDir, 'Not Valid', 'index.html'), 'x');
  await mkdir(join(dataDir, 'empty'));
  await mkdir(join(dataDir, 'admin'));
  await writeFile(join(dataDir, 'admin', 'index.html'), 'x');
  await store.upload('ok', Buffer.from(html('x')), 'html');
  assert.deepEqual((await store.list()).map((d) => d.slug), ['ok']);
});

test('single-deck mode refuses upload and remove', async (t) => {
  const { root, stateDir } = await tempDirs(t);
  const dir = join(root, 'My Talk');
  await mkdir(dir);
  await writeFile(join(dir, 'index.html'), html('Single'));
  const store = createDeckStore({ dataDir: root, stateDir, singleDeck: dir });
  assert.deepEqual((await store.list()).map((d) => d.slug), ['my-talk']);
  await assert.rejects(store.upload('x', Buffer.from(html('x')), 'html'), { code: 'ERR_SINGLE_DECK' });
  await assert.rejects(store.remove('my-talk'), { code: 'ERR_SINGLE_DECK' });
  await store.updateSlide('my-talk', 'a', { notes: 'n' });
  assert.equal((await store.readMeta('my-talk')).slides.a.notes, 'n');
});
