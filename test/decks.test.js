import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir, stat, symlink } from 'node:fs/promises';
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
    slidecast: 1, extra: 1, slides: { intro: { notes: 'old', extra: 1 } },
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

test('files lists regular, non-hidden files sorted by path', async (t) => {
  const { store, dataDir } = await setup(t);
  await store.upload('talk', Buffer.from(zipSync({
    'index.html': html('x'), 'img/a.png': new Uint8Array([1]), 'deck.json': strToU8('{}'),
  })), 'zip');
  const dir = join(dataDir, 'talk');
  await mkdir(join(dir, '.git'));
  await writeFile(join(dir, '.git', 'config'), 'x');
  await writeFile(join(dir, '.env'), 'SECRET=1');
  await symlink(join(dir, 'index.html'), join(dir, 'link.html'));
  const files = await store.files('talk');
  assert.deepEqual(files.map((f) => f.path), ['deck.json', 'img/a.png', 'index.html']);
  assert.equal(files[1].file, join(dir, 'img', 'a.png'));
  assert.equal(files[1].size, 1);
  assert.ok(files[1].mtime instanceof Date);
  await assert.rejects(store.files('nope'), { code: 'ERR_NOT_FOUND' });
});

// ---- stage and commit (0004) ------------------------------------------------

const deckHtml = (title = 'v') => html(title);
const meta = (m) => strToU8(JSON.stringify(m));
const at = (list) => list.map(([slide, step]) => ({ slide, step }));

async function stageSetup(t, opts = {}) {
  const dirs = await tempDirs(t);
  let clock = 1_000_000;
  const store = createDeckStore({ ...dirs, now: () => clock, ...opts });
  await store.upload('talk', Buffer.from(zipSync({
    'index.html': deckHtml('v1'),
    'deck.json': meta({ slidecast: 1, title: 'Old', slides: { a: { notes: 'A', steps: { 1: 'a1', 2: 'a2' } }, b: { notes: 'B' } } }),
  })), 'zip');
  return { ...dirs, store, tick: (ms) => { clock += ms; } };
}

test('stage then commit keeps notes by id and prunes the rest', async (t) => {
  const { store, dataDir, stateDir } = await stageSetup(t);
  const s = await store.stage('talk', Buffer.from(zipSync({ 'index.html': deckHtml('v2') })), 'zip');
  assert.deepEqual({ ...s, id: undefined }, { id: undefined, slug: 'talk', hasIncoming: false, incomingInvalid: false, same: false });
  assert.match(s.id, /^[0-9a-f]{12}$/);
  assert.match(await readFile(join(store.stageDir(s.id), 'index.html'), 'utf8'), /v2/);
  assert.deepEqual(await store.list().then((l) => l.map((d) => d.slug)), ['talk']);
  const sum = await store.stageSummary(s.id, at([['a', 0], ['a', 1]]));
  assert.equal(sum.incoming, null);
  assert.deepEqual(sum.current.removedSlides, ['b']);
  const r = await store.commitStage(s.id, { notes: 'current', steps: at([['a', 0], ['a', 1]]) });
  assert.deepEqual(r.removedSlides, ['b']);
  assert.deepEqual(r.removedSteps, [{ slide: 'a', step: 2 }]);
  const onDisk = JSON.parse(await readFile(join(dataDir, 'talk', 'deck.json'), 'utf8'));
  assert.deepEqual(onDisk.slides, { a: { notes: 'A', steps: { 1: 'a1' } } });
  assert.equal(onDisk.title, 'Old');
  assert.equal((await store.get('talk')).title, 'Old');
  assert.match(await readFile(join(dataDir, 'talk', 'index.html'), 'utf8'), /v2/);
  const trash = await readdir(join(stateDir, 'trash'));
  assert.equal(trash.length, 1);
  assert.equal(store.stageDir(s.id), null);
  await assert.rejects(store.commitStage(s.id, { notes: 'current', steps: null }), { code: 'ERR_STAGE_GONE' });
});

test('a zip with its own deck.json can be chosen whole', async (t) => {
  const { store, dataDir } = await stageSetup(t);
  const s = await store.stage('talk', Buffer.from(zipSync({
    'index.html': deckHtml('v2'),
    'deck.json': meta({ slidecast: 1, title: 'New', viewerNav: 'free', slides: { a: { notes: 'new A' }, z: { notes: 'Z' } } }),
  })), 'zip');
  assert.equal(s.hasIncoming, true);
  assert.equal(s.same, false);
  const sum = await store.stageSummary(s.id, at([['a', 0]]));
  assert.deepEqual(sum.incoming.removedSlides, ['z']);
  await store.commitStage(s.id, { notes: 'incoming', steps: at([['a', 0]]) });
  const onDisk = JSON.parse(await readFile(join(dataDir, 'talk', 'deck.json'), 'utf8'));
  assert.equal(onDisk.title, 'New');
  assert.equal(onDisk.viewerNav, 'free');
  assert.deepEqual(onDisk.slides, { a: { notes: 'new A' } });
});

test('the same deck.json with keys in another order counts as the same', async (t) => {
  const { store } = await stageSetup(t);
  const s = await store.stage('talk', Buffer.from(zipSync({
    'index.html': deckHtml('v2'),
    'deck.json': meta({ slides: { b: { notes: 'B' }, a: { steps: { 2: 'a2', 1: 'a1' }, notes: 'A' } }, title: 'Old' }),
  })), 'zip');
  assert.equal(s.same, true);
});

test('an invalid incoming deck.json counts as absent', async (t) => {
  const { store } = await stageSetup(t);
  const s = await store.stage('talk', Buffer.from(zipSync({ 'index.html': deckHtml('v2'), 'deck.json': strToU8('{nope') })), 'zip');
  assert.equal(s.incomingInvalid, true);
  assert.equal(s.hasIncoming, false);
  await assert.rejects(store.commitStage(s.id, { notes: 'incoming', steps: null }), { code: 'ERR_BAD_INPUT' });
  await assert.rejects(store.commitStage(s.id, { notes: 'mine', steps: null }), { code: 'ERR_BAD_INPUT' });
  await store.commitStage(s.id, { notes: 'current', steps: null });
});

test('notes edited between stage and commit are kept', async (t) => {
  const { store } = await stageSetup(t);
  const s = await store.stage('talk', Buffer.from(deckHtml('v2')), 'html');
  await store.updateSlide('talk', 'a', { notes: 'edited' });
  await store.commitStage(s.id, { notes: 'current', steps: at([['a', 0]]) });
  assert.equal((await store.readMeta('talk')).slides.a.notes, 'edited');
});

test('a deck replaced since the stage answers ERR_CONFLICT and stays as is', async (t) => {
  const { store, dataDir } = await stageSetup(t);
  const s = await store.stage('talk', Buffer.from(deckHtml('v2')), 'html');
  const dir = store.stageDir(s.id);
  await store.upload('talk', Buffer.from(deckHtml('other')), 'html');
  await assert.rejects(store.commitStage(s.id, { notes: 'current', steps: null }), { code: 'ERR_CONFLICT' });
  assert.match(await readFile(join(dataDir, 'talk', 'index.html'), 'utf8'), /other/);
  await assert.rejects(stat(dir), { code: 'ENOENT' });
});

test('stages expire, and a new stage replaces the previous one', async (t) => {
  const { store, tick } = await stageSetup(t, { stageTtlMs: 1000 });
  const s1 = await store.stage('talk', Buffer.from(deckHtml('v2')), 'html');
  const dir1 = store.stageDir(s1.id);
  tick(1001);
  assert.equal(store.stageDir(s1.id), null);
  await assert.rejects(store.commitStage(s1.id, { notes: 'current', steps: null }), { code: 'ERR_STAGE_GONE' });
  await assert.rejects(store.stageSummary(s1.id, null), { code: 'ERR_STAGE_GONE' });
  const s2 = await store.stage('talk', Buffer.from(deckHtml('v3')), 'html');
  await assert.rejects(stat(dir1), { code: 'ENOENT' });
  const dir2 = store.stageDir(s2.id);
  const s3 = await store.stage('talk', Buffer.from(deckHtml('v4')), 'html');
  assert.equal(store.stageDir(s2.id), null);
  await assert.rejects(stat(dir2), { code: 'ENOENT' });
  assert.ok(store.stageDir(s3.id));
});

test('stage refuses single-deck mode and unknown decks', async (t) => {
  const { store } = await stageSetup(t);
  await assert.rejects(store.stage('nope', Buffer.from(deckHtml()), 'html'), { code: 'ERR_NOT_FOUND' });
  await assert.rejects(store.stage('admin', Buffer.from(deckHtml()), 'html'), { code: 'ERR_BAD_SLUG' });
  const { root, stateDir } = await tempDirs(t);
  const dir = join(root, 'solo');
  await mkdir(dir);
  await writeFile(join(dir, 'index.html'), html('Single'));
  const single = createDeckStore({ dataDir: root, stateDir, singleDeck: dir });
  await assert.rejects(single.stage('solo', Buffer.from(deckHtml()), 'html'), { code: 'ERR_SINGLE_DECK' });
});

test('leftover staging folders are removed when the store starts', async (t) => {
  const dirs = await tempDirs(t);
  await mkdir(join(dirs.dataDir, '.stage-x'));
  await writeFile(join(dirs.dataDir, '.stage-x', 'index.html'), 'x');
  await mkdir(join(dirs.dataDir, '.upload-y'));
  await mkdir(join(dirs.dataDir, '.keep'));
  const store = createDeckStore(dirs);
  await store.ready;
  assert.deepEqual(await readdir(dirs.dataDir), ['.keep']);
  assert.deepEqual(await store.list(), []);
});

test('discarding a stage while it commits does not break the commit', async (t) => {
  const { store, dataDir } = await stageSetup(t);
  const s = await store.stage('talk', Buffer.from(deckHtml('v2')), 'html');
  const commit = store.commitStage(s.id, { notes: 'current', steps: null });
  const discard = store.discardStage(s.id);
  await Promise.all([commit, discard]);
  assert.match(await readFile(join(dataDir, 'talk', 'index.html'), 'utf8'), /v2/);
  assert.equal((await store.readMeta('talk')).slides.b.notes, 'B');
  await store.discardStage(s.id);
  await store.discardStage('zz');
});

test('an expired stage folder is removed without waiting for the next stage', async (t) => {
  const dirs = await tempDirs(t);
  const store = createDeckStore({ ...dirs, stageTtlMs: 50 });
  await store.upload('talk', Buffer.from(deckHtml('v1')), 'html');
  const s = await store.stage('talk', Buffer.from(deckHtml('v2')), 'html');
  const dir = store.stageDir(s.id);
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(stat(dir), { code: 'ENOENT' });
});
