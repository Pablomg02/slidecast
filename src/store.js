import { open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const locks = new Map();

// Serialise async work per key: each call waits for the previous one.
export function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

export async function readJson(path, fallback) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  return JSON.parse(text);
}

// Write to a temp file, fsync, then rename over the target, so readers never
// see a half-written file. Concurrent writes to one path are serialised.
export function writeJsonAtomic(path, value) {
  return withLock(path, async () => {
    const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(value, null, 2) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  });
}
