import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';

const deflateRawAsync = promisify(deflateRaw);

// Text formats are deflated; everything else (images, video, fonts) is
// usually compressed already and is stored as is.
const DEFLATE = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.svg', '.xml', '.csv']);
const FLAG_UTF8 = 0x0800;
const MADE_BY_UNIX = 0x0314;
const VERSION_NEEDED = 20;
// A regular file, rw-r--r--: without it Info-ZIP unzip extracts with mode 000.
const FILE_ATTRS = (0o100644 << 16) >>> 0;

// zlib.crc32 is missing on early Node 20.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

// `crc` continues a CRC computed over the bytes before `buf`.
export function crc32(buf, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function fileCrc(file) {
  let crc = 0;
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    crc = crc32(chunk, crc);
    size += chunk.length;
  }
  return { crc, size };
}

function dosDateTime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime()) || d.getFullYear() < 1980) {
    return { date: (1 << 5) | 1, time: 0 };
  }
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

// Streams a zip of entries `{ path, mtime, file }` (read from disk) or
// `{ path, mtime, data }`. Text files are read whole and deflated; stored
// files are streamed from disk (read twice: once for the CRC). No zip64.
// `check()`, if given, runs before each entry and before the end: if it
// throws, the stream fails instead of delivering a mixed archive.
export function zipStream(entries, { check = async () => {} } = {}) {
  async function* generate() {
    const central = [];
    let offset = 0;
    for (const e of entries) {
      await check();
      const name = Buffer.from(e.path, 'utf8');
      const method = DEFLATE.has(extname(e.path).toLowerCase()) ? 8 : 0;
      let body = null;
      let crc;
      let rawSize;
      let bodySize;
      if (method === 8 || e.data) {
        const raw = e.data ?? await readFile(e.file);
        body = method === 8 ? await deflateRawAsync(raw) : raw;
        crc = crc32(raw);
        rawSize = raw.length;
        bodySize = body.length;
      } else {
        ({ crc, size: rawSize } = await fileCrc(e.file));
        bodySize = rawSize;
      }
      const { date, time } = dosDateTime(e.mtime);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(VERSION_NEEDED, 4);
      local.writeUInt16LE(FLAG_UTF8, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(bodySize, 18);
      local.writeUInt32LE(rawSize, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(MADE_BY_UNIX, 4);
      cd.writeUInt16LE(VERSION_NEEDED, 6);
      cd.writeUInt16LE(FLAG_UTF8, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(bodySize, 20);
      cd.writeUInt32LE(rawSize, 24);
      cd.writeUInt16LE(name.length, 28);
      cd.writeUInt32LE(FILE_ATTRS, 38);
      cd.writeUInt32LE(offset, 42);
      central.push(cd, name);

      yield Buffer.concat([local, name]);
      if (body) {
        yield body;
      } else {
        let sent = 0;
        let crc2 = 0;
        for await (const chunk of createReadStream(e.file)) {
          sent += chunk.length;
          crc2 = crc32(chunk, crc2);
          yield chunk;
        }
        if (sent !== rawSize || crc2 !== crc) throw new Error(`${e.path} changed while zipping`);
      }
      offset += local.length + name.length + bodySize;
    }
    await check();
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    yield cdBuf;
    yield eocd;
  }
  return Readable.from(generate(), { objectMode: false });
}
