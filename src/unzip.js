import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = {
  maxEntries: 5000,
  maxTotalBytes: 300 * 1024 * 1024,
};

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ERR_ZIP';
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError('not a zip file');
}

// Returns the entry path split into segments, or throws if it is unsafe.
export function safeEntryPath(name) {
  if (name.includes('\\')) throw new ZipError(`backslash in entry name: ${name}`);
  if (name.includes('\0')) throw new ZipError('NUL in entry name');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new ZipError(`absolute entry path: ${name}`);
  }
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new ZipError(`entry escapes the folder: ${name}`);
  return parts;
}

// Reads every file of a zip held in memory. Rejects encrypted, zip64, symlink
// and unsafe entries, and stops before more than maxTotalBytes are inflated,
// whatever sizes the archive declares.
export function readZip(buf, limits = ZIP_LIMITS) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported');
  }
  if (count > limits.maxEntries) throw new ZipError(`more than ${limits.maxEntries} entries`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('truncated zip');

  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let declaredTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError('corrupt central directory');
    }
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new ZipError('encrypted zip entries are not supported');
    if (madeBy >> 8 === 3 && ((attrs >>> 16) & S_IFMT) === S_IFLNK) {
      throw new ZipError(`symlink entry: ${name}`);
    }
    const parts = safeEntryPath(name);
    const isDir = name.endsWith('/');
    if (isDir || parts.length === 0) continue;
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression in ${name}`);
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipError('archive too large when uncompressed');
    entries.push({ name, parts, method, compSize, size, localOffset });
  }

  let total = 0;
  return entries.map((e) => {
    const lp = e.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== SIG_LOCAL) {
      throw new ZipError(`corrupt local header for ${e.name}`);
    }
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    if (start + e.compSize > buf.length) throw new ZipError(`truncated data for ${e.name}`);
    const raw = buf.subarray(start, start + e.compSize);
    let data;
    if (e.method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
      } catch {
        throw new ZipError(`bad or oversized data in ${e.name}`);
      }
    }
    if (data.length !== e.size) throw new ZipError(`size mismatch in ${e.name}`);
    total += data.length;
    if (total > limits.maxTotalBytes) throw new ZipError('archive too large when uncompressed');
    return { parts: e.parts, data };
  });
}
