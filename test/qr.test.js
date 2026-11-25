import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { qrMatrix, QR_MAX_BYTES } from '../public/qr.js';

// The join screen's QR codes (0011) read back with an independent decoder.

function decode(m, scale = 4) {
  const quiet = 4;
  const w = (m.length + quiet * 2) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (!m[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4;
          px[i] = 0;
          px[i + 1] = 0;
          px[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(px, w, w)?.data ?? null;
}

test('every length up to the limit encodes and decodes back, versions 1 to 10', () => {
  const sizes = new Set();
  for (let len = 1; len <= QR_MAX_BYTES; len++) {
    const s = Array.from({ length: len }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789/:.-'[(i * 7 + len) % 40]).join('');
    const m = qrMatrix(s);
    sizes.add(m.length);
    assert.equal(decode(m), s, `length ${len}`);
  }
  assert.deepEqual([...sizes].sort((a, b) => a - b), [21, 25, 29, 33, 37, 41, 45, 49, 53, 57]);
});

test('real addresses decode, UTF-8 included; too long gives null', () => {
  for (const s of ['https://slides.example.org/clase-3/view', 'http://192.168.1.20:4321/talk/view', 'https://exämple.org/ñ']) {
    assert.equal(decode(qrMatrix(s)), s);
  }
  assert.equal(qrMatrix('x'.repeat(QR_MAX_BYTES + 1)), null);
});
