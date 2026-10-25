import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { crc32, zipStream } from '../src/zipwrite.js';
import { readZip } from '../src/unzip.js';
import { tempDirs } from './helpers.js';

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

// Central directory entries, read straight from the bytes.
function central(buf) {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    out.push({
      madeBy: buf.readUInt16LE(p + 4),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      date: buf.readUInt16LE(p + 14),
      attrs: buf.readUInt32LE(p + 38),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

test('crc32 of the check string', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('a zip is read back by readZip and fflate with the same names and bytes', async (t) => {
  const { root } = await tempDirs(t);
  const png = randomBytes(5000);
  const pngFile = join(root, 'a.png');
  await writeFile(pngFile, png);
  const files = {
    'index.html': Buffer.from('<!doctype html><title>x</title>'.repeat(50)),
    'img/a.png': png,
    'deck.json': Buffer.from('{"slidecast":1}'),
    'ñandú.txt': Buffer.from('hola'),
  };
  const mtime = new Date();
  const zip = await collect(zipStream([
    { path: 'index.html', mtime, data: files['index.html'] },
    { path: 'img/a.png', mtime, file: pngFile },
    { path: 'deck.json', mtime, data: files['deck.json'] },
    { path: 'ñandú.txt', mtime, data: files['ñandú.txt'] },
  ]));
  const ours = Object.fromEntries(readZip(zip).map((e) => [e.parts.join('/'), e.data]));
  assert.deepEqual(Object.keys(ours).sort(), Object.keys(files).sort());
  for (const [k, v] of Object.entries(files)) assert.ok(ours[k].equals(v), k);
  const theirs = unzipSync(new Uint8Array(zip));
  for (const [k, v] of Object.entries(files)) assert.ok(Buffer.from(theirs[k]).equals(v), k);

  const cd = Object.fromEntries(central(zip).map((e) => [e.name, e]));
  assert.equal(cd['img/a.png'].method, 0);
  assert.equal(cd['index.html'].method, 8);
  for (const e of Object.values(cd)) {
    assert.equal(e.madeBy, 0x0314);
    assert.equal(e.attrs, 0x81A40000);
    assert.equal(e.flags & 0x0800, 0x0800);
  }
});

test('empty files and empty archives are valid', async () => {
  const empty = await collect(zipStream([]));
  assert.deepEqual(readZip(empty), []);
  assert.deepEqual(unzipSync(new Uint8Array(empty)), {});
  const one = await collect(zipStream([
    { path: 'e.html', mtime: new Date(), data: Buffer.alloc(0) },
    { path: 'e.bin', mtime: new Date(), data: Buffer.alloc(0) },
  ]));
  const entries = readZip(one);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.data.length === 0));
  assert.equal(Buffer.from(unzipSync(new Uint8Array(one))['e.html']).length, 0);
});

test('dates before 1980 are clamped to 1980-01-01', async (t) => {
  const { root } = await tempDirs(t);
  const f = join(root, 'old.txt');
  await writeFile(f, 'old');
  await utimes(f, new Date(0), new Date(0));
  const zip = await collect(zipStream([{ path: 'old.txt', mtime: new Date(0), file: f }]));
  const [e] = central(zip);
  assert.equal(e.date, (0 << 9) | (1 << 5) | 1);
});

test('a failing check before an entry ends the stream with an error', async () => {
  let calls = 0;
  const stream = zipStream([
    { path: 'a.txt', mtime: new Date(), data: Buffer.from('a') },
    { path: 'b.txt', mtime: new Date(), data: Buffer.from('b') },
  ], { check: async () => { if (++calls > 1) throw new Error('deck changed'); } });
  await assert.rejects(collect(stream), /deck changed/);
});

test('a stored file is streamed from disk with the right CRC', async (t) => {
  const { root } = await tempDirs(t);
  const big = randomBytes(3 * 1024 * 1024 + 7);
  const f = join(root, 'v.mp4');
  await writeFile(f, big);
  const zip = await collect(zipStream([{ path: 'v.mp4', mtime: new Date(), file: f }]));
  assert.ok(Buffer.from(unzipSync(new Uint8Array(zip))['v.mp4']).equals(big));
  assert.ok(readZip(zip)[0].data.equals(big));
});
