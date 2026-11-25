// QR codes for the join screen (0011): byte mode, error correction level M,
// versions 1 to 10 (up to 213 bytes, plenty for a room's address). No DOM:
// qrMatrix gives the modules, the page draws them.
// Follows ISO/IEC 18004; the structure is that of Project Nayuki's encoder.

// Level M, per version: EC codewords per block, then [blocks, data codewords
// per block] for each group.
const BLOCKS_M = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const QR_MAX_BYTES = 213;

const dataCodewords = (v) => BLOCKS_M[v].slice(1).reduce((n, [b, d]) => n + b * d, 0);
const bit = (x, i) => ((x >>> i) & 1) !== 0;

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----------------------------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

// ---- codewords ----------------------------------------------------------------

function encodeData(bytes, version) {
  const bits = [];
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push(bit(value, i)); };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | (b ? 1 : 0), 0));
  return out;
}

// Splits into blocks, adds each block's error correction, interleaves.
function withErrorCorrection(data, version) {
  const [ecLen, ...groups] = BLOCKS_M[version];
  const divisor = rsDivisor(ecLen);
  const blocks = [];
  let at = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(at, at + len);
      at += len;
      blocks.push({ d, ec: rsRemainder(d, divisor) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---- the symbol -------------------------------------------------------------------

function makeGrid(version) {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true; };
  return { version, size, dark, fixed, set };
}

function drawFormat(g, mask) {
  const data = (0b00 << 3) | mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const { set, size } = g;
  for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6));
  set(8, 8, bit(bits, 7));
  set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true); // the dark module
}

function drawFunctionPatterns(g) {
  const { size, set, version } = g;
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const pos = ALIGN[version];
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(g, 0); // reserves its modules; the real mask is drawn later
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
}

function drawCodewords(g, codewords) {
  const { size, dark, fixed } = g;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y][x]) continue;
        // Past the last codeword: remainder bits, light.
        dark[y][x] = i < codewords.length * 8 && bit(codewords[i >>> 3], 7 - (i & 7));
        i++;
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g, mask) {
  const { size, dark, fixed } = g;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x];
  }
}

// The standard's penalty score: lower reads better.
function penalty({ size, dark }) {
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(dark[i]);
    lines.push(dark.map((row) => row[i]));
  }
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
        continue;
      }
      if (run >= 5) score += run - 2;
      run = 1;
    }
    // 1:1:3:1:1 with four light modules on one side (outside counts as light).
    const at = (i) => (i >= 0 && i < size ? line[i] : false);
    for (let i = -4; i < size; i++) {
      if (!finder.every((v, k) => at(i + k) === v)) continue;
      const before = [1, 2, 3, 4].every((k) => !at(i - k));
      const after = [7, 8, 9, 10].every((k) => !at(i + k));
      if (before || after) score += 40;
    }
  }
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark[y][x]) darkCount++;
      if (x < size - 1 && y < size - 1) {
        const c = dark[y][x];
        if (dark[y][x + 1] === c && dark[y + 1][x] === c && dark[y + 1][x + 1] === c) score += 3;
      }
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// The modules of the QR code for `text`, rows of booleans (true: dark),
// without the quiet zone; null when the text is too long.
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 1;
  while (version <= 10 && dataCodewords(version) < bytes.length + (version < 10 ? 2 : 3)) version++;
  if (version > 10) return null;
  const codewords = withErrorCorrection(encodeData(bytes, version), version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = makeGrid(version);
    drawFunctionPatterns(g);
    drawCodewords(g, codewords);
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g);
    if (!best || score < best.score) best = { score, dark: g.dark };
  }
  return best.dark;
}
