import {
  readdir, stat, mkdir, rename, rm, cp, writeFile, open,
} from 'node:fs/promises';
import { join, basename, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic, withLock } from './store.js';
import { readZip } from './unzip.js';
import { pruneSlides, summarize } from './notes.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'ws', '_slidecast', '_deck', '_stage', 'health', 'favicon.ico', 'robots.txt',
]);
export const VIEWER_NAV = ['follow', 'back', 'free'];
const ASPECT_RE = /^\d+:\d+$/;
const MAX_NOTE = 100_000;
// Looked for at the deck's root when deck.json names no `cover`.
export const COVER_FILES = ['cover.webp', 'cover.png', 'cover.jpg', 'cover.jpeg', 'cover.avif', 'cover.svg'];
const COVER_RE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[^\0\\]{1,200}\.(webp|png|jpe?g|avif|gif|svg)$/i;

export class DeckError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

function assertSlug(slug) {
  if (!isValidSlug(slug)) throw new DeckError('ERR_BAD_SLUG', `invalid deck name: ${slug}`);
}

// Folder name → slug, for single-deck mode where the folder can be named anything.
export function slugFromFolder(dir) {
  const s = basename(resolve(dir)).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return isValidSlug(s) ? s : 'deck';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

async function htmlTitle(file) {
  let fh;
  try {
    fh = await open(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buf.subarray(0, bytesRead).toString('utf8'));
    return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
  } catch {
    return '';
  } finally {
    await fh?.close();
  }
}

async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}

export function normalizeMeta(raw) {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  m.slidecast = 1;
  if (typeof m.title !== 'string') delete m.title;
  if (typeof m.aspect !== 'string' || !ASPECT_RE.test(m.aspect)) m.aspect = '16:9';
  if (!VIEWER_NAV.includes(m.viewerNav)) m.viewerNav = 'back';
  if (!m.slides || typeof m.slides !== 'object' || Array.isArray(m.slides)) m.slides = {};
  return m;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// rename() across filesystems (e.g. two Docker volumes) fails with EXDEV.
async function move(from, to) {
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

// JSON with object keys sorted, so two files that differ only in key order
// compare equal.
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const STAGE_ID_RE = /^[0-9a-f]{12}$/;

function checkNote(v, what) {
  if (typeof v !== 'string') throw new DeckError('ERR_BAD_INPUT', `${what} must be a string`);
  if (v.length > MAX_NOTE) throw new DeckError('ERR_BAD_INPUT', `${what} is too long`);
}

export function createDeckStore({
  dataDir, stateDir, singleDeck = null, log = () => {}, stageTtlMs = 30 * 60 * 1000, now = Date.now,
}) {
  const single = singleDeck ? { slug: slugFromFolder(singleDeck), dir: resolve(singleDeck) } : null;
  const root = resolve(dataDir);
  const trashDir = join(stateDir, 'trash');
  const ignored = new Set();
  // Staged new versions of decks, waiting for the admin to confirm (0004).
  const stages = new Map(); // id → {id, slug, dir, base, incoming, createdAt}

  // Staging folders left by a crash or a restart.
  async function cleanup() {
    if (single) return;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      if (e.isDirectory() && /^\.(stage|upload)-/.test(e.name)) {
        await rm(join(root, e.name), { recursive: true, force: true });
      }
    }
  }
  const ready = cleanup().catch((err) => log(`could not remove old staging folders: ${err.message}`));

  function dirOf(slug) {
    if (single) return slug === single.slug ? single.dir : null;
    return isValidSlug(slug) ? join(root, slug) : null;
  }

  async function exists(slug) {
    const dir = dirOf(slug);
    if (!dir) return false;
    try {
      return (await stat(join(dir, 'index.html'))).isFile();
    } catch {
      return false;
    }
  }

  async function slugs() {
    if (single) return (await exists(single.slug)) ? [single.slug] : [];
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (!isValidSlug(e.name)) {
        if (!ignored.has(e.name)) {
          ignored.add(e.name);
          log(`ignoring folder "${e.name}": not a valid deck name`);
        }
        continue;
      }
      if (await exists(e.name)) out.push(e.name);
    }
    return out.sort();
  }

  async function readMeta(slug) {
    const dir = dirOf(slug);
    if (!dir) throw new DeckError('ERR_NOT_FOUND');
    let raw;
    try {
      raw = await readJson(join(dir, 'deck.json'), {});
    } catch {
      log(`deck "${slug}": deck.json is not valid JSON, using defaults`);
      raw = {};
    }
    return normalizeMeta(raw);
  }

  async function title(slug, meta) {
    return meta.title || (await htmlTitle(join(dirOf(slug), 'index.html'))) || slug;
  }

  // Relative path of the deck's cover image, or null.
  async function cover(slug, meta) {
    const dir = dirOf(slug);
    const names = typeof meta.cover === 'string' && COVER_RE.test(meta.cover) ? [meta.cover] : COVER_FILES;
    for (const name of names) {
      try {
        if ((await stat(join(dir, name))).isFile()) return name;
      } catch { /* next */ }
    }
    return null;
  }

  async function get(slug) {
    if (!(await exists(slug))) return null;
    const meta = await readMeta(slug);
    return { slug, dir: dirOf(slug), meta, title: await title(slug, meta), cover: await cover(slug, meta) };
  }

  async function list() {
    const out = [];
    for (const slug of await slugs()) {
      const dir = dirOf(slug);
      const meta = await readMeta(slug);
      const st = await stat(join(dir, 'index.html'));
      out.push({
        slug,
        title: await title(slug, meta),
        aspect: meta.aspect,
        cover: await cover(slug, meta),
        size: await dirSize(dir),
        mtime: st.mtime.toISOString(),
      });
    }
    return out;
  }

  // Read-modify-write of deck.json under a lock; an invalid existing file is
  // an error here, so a write never silently discards its content.
  async function modifyMeta(slug, fn) {
    if (!(await exists(slug))) throw new DeckError('ERR_NOT_FOUND');
    const path = join(dirOf(slug), 'deck.json');
    return withLock(`meta:${path}`, async () => {
      let raw;
      try {
        raw = await readJson(path, {});
      } catch {
        throw new DeckError('ERR_BAD_META', 'deck.json is not valid JSON');
      }
      const meta = normalizeMeta(raw);
      fn(meta);
      await writeJsonAtomic(path, meta);
      return meta;
    });
  }

  async function updateSlide(slug, slideId, { notes = '', steps = {} } = {}) {
    if (typeof slideId !== 'string' || !slideId || slideId.length > 200 || /[\0-\x1f]/.test(slideId)) {
      throw new DeckError('ERR_BAD_INPUT', 'invalid slide id');
    }
    checkNote(notes, 'notes');
    if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
      throw new DeckError('ERR_BAD_INPUT', 'steps must be an object');
    }
    const cleanSteps = {};
    for (const [k, v] of Object.entries(steps)) {
      if (!/^\d{1,4}$/.test(k)) throw new DeckError('ERR_BAD_INPUT', `invalid step key ${k}`);
      checkNote(v, `step ${k}`);
      if (v !== '') cleanSteps[String(Number(k))] = v;
    }
    return modifyMeta(slug, (meta) => {
      const slide = { ...(meta.slides[slideId] ?? {}) };
      slide.notes = notes;
      if (Object.keys(cleanSteps).length) slide.steps = cleanSteps;
      else delete slide.steps;
      meta.slides[slideId] = slide;
    });
  }

  async function updateSettings(slug, { title: t, viewerNav, aspect } = {}) {
    if (t !== undefined && t !== null && (typeof t !== 'string' || t.length > 200)) {
      throw new DeckError('ERR_BAD_INPUT', 'invalid title');
    }
    if (viewerNav !== undefined && !VIEWER_NAV.includes(viewerNav)) {
      throw new DeckError('ERR_BAD_INPUT', 'invalid viewerNav');
    }
    if (aspect !== undefined && (typeof aspect !== 'string' || !ASPECT_RE.test(aspect))) {
      throw new DeckError('ERR_BAD_INPUT', 'invalid aspect');
    }
    return modifyMeta(slug, (meta) => {
      if (t === null || t === '') delete meta.title;
      else if (t !== undefined) meta.title = t.trim();
      if (viewerNav !== undefined) meta.viewerNav = viewerNav;
      if (aspect !== undefined) meta.aspect = aspect;
    });
  }

  // Turns the zip entries into {relativePath: data}, stripping one top-level
  // folder when index.html is not at the root.
  function zipFiles(buffer) {
    const entries = readZip(buffer).filter((e) => e.parts[0] !== '__MACOSX');
    const hasRootIndex = entries.some((e) => e.parts.length === 1 && e.parts[0] === 'index.html');
    let strip = 0;
    if (!hasRootIndex) {
      const top = new Set(entries.map((e) => (e.parts.length > 1 ? e.parts[0] : null)));
      const [only] = top;
      const nested = top.size === 1 && only !== null
        && entries.some((e) => e.parts.length === 2 && e.parts[1] === 'index.html');
      if (!nested) throw new DeckError('ERR_NO_INDEX', 'the zip has no index.html');
      strip = 1;
    }
    return entries.map((e) => ({ path: e.parts.slice(strip).join('/'), data: e.data }));
  }

  function uploadFiles(buffer, kind) {
    if (kind === 'zip') return zipFiles(buffer);
    if (kind === 'html') return [{ path: 'index.html', data: buffer }];
    throw new DeckError('ERR_BAD_INPUT', 'unknown upload kind');
  }

  // Writes the files into a new hidden folder of dataDir, never listed as a deck.
  async function writeStaging(files, name) {
    await mkdir(root, { recursive: true });
    const dir = join(root, name);
    await mkdir(dir);
    try {
      for (const f of files) {
        const target = resolve(dir, f.path);
        if (!target.startsWith(dir + sep)) throw new DeckError('ERR_ZIP', `unsafe path ${f.path}`);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, f.data, { flag: 'wx' });
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    return dir;
  }

  // Moves the deck's folder to the trash and puts `dir` in its place. Run
  // under the deck lock.
  async function swapIn(slug, dir) {
    const target = join(root, slug);
    let replaced = false;
    try {
      await stat(target);
      replaced = true;
    } catch { /* new deck */ }
    if (replaced) {
      await mkdir(trashDir, { recursive: true });
      await move(target, join(trashDir, `${slug}-${timestamp()}`));
    }
    await rename(dir, target);
    return replaced;
  }

  async function upload(slug, buffer, kind) {
    if (single) throw new DeckError('ERR_SINGLE_DECK');
    assertSlug(slug);
    const files = uploadFiles(buffer, kind);
    await ready;
    const staging = await writeStaging(files, `.upload-${randomBytes(6).toString('hex')}`);
    try {
      return await withLock(`deck:${slug}`, async () => {
        if (!files.some((f) => f.path === 'deck.json')) {
          await cp(join(root, slug, 'deck.json'), join(staging, 'deck.json')).catch(() => {});
        }
        const replaced = await swapIn(slug, staging);
        return { slug, replaced };
      });
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  // Every regular file of a deck, for the download: hidden paths and anything
  // that is not a regular file (symlinks included) are left out.
  async function files(slug) {
    if (!(await exists(slug))) throw new DeckError('ERR_NOT_FOUND');
    const out = [];
    async function walk(dir, prefix) {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const file = join(dir, e.name);
        const path = prefix + e.name;
        if (e.isDirectory()) await walk(file, `${path}/`);
        else if (e.isFile()) {
          const st = await stat(file);
          out.push({ path, file, size: st.size, mtime: st.mtime });
        }
      }
    }
    await walk(dirOf(slug), '');
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // ---- update in two phases (0004) ---------------------------------------

  // Changes whenever the deck's folder is replaced: every upload or commit
  // writes a new index.html.
  async function version(slug) {
    const st = await stat(join(dirOf(slug), 'index.html'));
    return `${st.ino}-${st.mtimeMs}`;
  }

  const expired = (s) => now() - s.createdAt > stageTtlMs;

  // Forgets a stage and removes its folder. Run under the deck lock.
  async function dropStage(s) {
    if (stages.get(s.id) === s) stages.delete(s.id);
    await rm(s.dir, { recursive: true, force: true });
  }

  async function sweepExpired() {
    for (const s of [...stages.values()]) {
      if (expired(s)) await withLock(`deck:${s.slug}`, () => (stages.get(s.id) === s ? dropStage(s) : null));
    }
  }

  function liveStage(id) {
    if (typeof id !== 'string' || !STAGE_ID_RE.test(id)) return null;
    const s = stages.get(id);
    return s && !expired(s) ? s : null;
  }

  async function stage(slug, buffer, kind) {
    if (single) throw new DeckError('ERR_SINGLE_DECK');
    assertSlug(slug);
    if (!(await exists(slug))) throw new DeckError('ERR_NOT_FOUND');
    const files = uploadFiles(buffer, kind);
    await ready;
    await sweepExpired();
    const id = randomBytes(6).toString('hex');
    const dir = await writeStaging(files, `.stage-${id}`);
    try {
      let incoming = null;
      let incomingInvalid = false;
      try {
        const raw = await readJson(join(dir, 'deck.json'), null);
        if (raw !== null) incoming = normalizeMeta(raw);
      } catch {
        incomingInvalid = true;
      }
      return await withLock(`deck:${slug}`, async () => {
        if (!(await exists(slug))) throw new DeckError('ERR_NOT_FOUND');
        for (const old of [...stages.values()]) if (old.slug === slug) await dropStage(old);
        const current = await readMeta(slug);
        const same = incoming !== null && canonicalJson(incoming) === canonicalJson(current);
        stages.set(id, { id, slug, dir, base: await version(slug), incoming, createdAt: now() });
        // Its folder goes once it expires, even if no other update follows.
        setTimeout(() => sweepExpired().catch((err) => log(`could not remove an expired stage: ${err.message}`)),
          stageTtlMs + 100).unref();
        return { id, slug, hasIncoming: incoming !== null, incomingInvalid, same };
      });
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  function stageDir(id) {
    return liveStage(id)?.dir ?? null;
  }

  async function stageSummary(id, steps) {
    const s = liveStage(id);
    if (!s) throw new DeckError('ERR_STAGE_GONE');
    return {
      current: summarize((await readMeta(s.slug)).slides, steps),
      incoming: s.incoming ? summarize(s.incoming.slides, steps) : null,
    };
  }

  // Puts the staged version in place with the chosen notes, pruned to the
  // slides it has. The current notes are read at this moment, so edits made
  // since the stage are kept.
  async function commitStage(id, { notes, steps } = {}) {
    if (typeof id !== 'string' || !STAGE_ID_RE.test(id)) throw new DeckError('ERR_STAGE_GONE');
    if (notes !== 'current' && notes !== 'incoming') throw new DeckError('ERR_BAD_INPUT', 'notes must be current or incoming');
    const found = stages.get(id);
    if (!found) throw new DeckError('ERR_STAGE_GONE');
    if (notes === 'incoming' && !found.incoming) throw new DeckError('ERR_BAD_INPUT', 'the upload has no valid deck.json');
    const { slug } = found;
    return withLock(`deck:${slug}`, async () => {
      const s = stages.get(id);
      if (!s) throw new DeckError('ERR_STAGE_GONE');
      stages.delete(id);
      try {
        if (expired(s)) throw new DeckError('ERR_STAGE_GONE');
        if (!(await exists(slug)) || (await version(slug)) !== s.base) throw new DeckError('ERR_CONFLICT');
        const path = join(dirOf(slug), 'deck.json');
        return await withLock(`meta:${path}`, async () => {
          let chosen = s.incoming;
          if (notes === 'current') {
            try {
              chosen = normalizeMeta(await readJson(path, {}));
            } catch {
              throw new DeckError('ERR_BAD_META', 'deck.json is not valid JSON');
            }
          }
          const pruned = pruneSlides(chosen.slides, steps);
          const meta = { ...chosen, slides: pruned.slides };
          await writeJsonAtomic(join(s.dir, 'deck.json'), meta);
          await swapIn(slug, s.dir);
          return { slug, meta, removedSlides: pruned.removedSlides, removedSteps: pruned.removedSteps };
        });
      } catch (err) {
        await rm(s.dir, { recursive: true, force: true });
        throw err;
      }
    });
  }

  async function discardStage(id) {
    const s = typeof id === 'string' ? stages.get(id) : undefined;
    if (!s) return;
    await withLock(`deck:${s.slug}`, () => (stages.get(id) === s ? dropStage(s) : null));
  }

  async function remove(slug) {
    if (single) throw new DeckError('ERR_SINGLE_DECK');
    assertSlug(slug);
    return withLock(`deck:${slug}`, async () => {
      if (!(await exists(slug))) throw new DeckError('ERR_NOT_FOUND');
      await mkdir(trashDir, { recursive: true });
      const to = join(trashDir, `${slug}-${timestamp()}`);
      await move(join(root, slug), to);
      return to;
    });
  }

  return {
    single, ready, list, slugs, get, exists, readMeta, updateSlide, updateSettings, upload, remove, dirOf, files,
    version, stage, stageDir, stageSummary, commitStage, discardStage,
  };
}
