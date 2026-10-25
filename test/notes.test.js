import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, pruneSlides, summarize } from '../src/notes.js';

const steps = (list) => list.map(([slide, step]) => ({ slide, step }));

test('pruneSlides drops removed slides and steps, keeps unknown fields', () => {
  const slides = {
    a: { notes: 'A', steps: { 1: 'a1', 2: 'a2' }, color: 'red' },
    b: { notes: 'B' },
    c: { notes: '', steps: { 1: 'c1' } },
    d: { notes: '' },
  };
  const copy = structuredClone(slides);
  const r = pruneSlides(slides, steps([['a', 0], ['a', 1], ['c', 0]]));
  assert.deepEqual(r.slides, { a: { notes: 'A', steps: { 1: 'a1' }, color: 'red' }, c: { notes: '' } });
  assert.deepEqual(r.removedSlides, ['b']);
  assert.deepEqual(r.removedSteps, [{ slide: 'a', step: 2 }, { slide: 'c', step: 1 }]);
  assert.deepEqual(slides, copy, 'input not mutated');
});

test('pruneSlides with null steps changes nothing', () => {
  const slides = { a: { notes: 'A' } };
  assert.deepEqual(pruneSlides(slides, null), { slides, removedSlides: [], removedSteps: [] });
});

test('parseSteps validates the list and skips bad items', () => {
  assert.equal(parseSteps(null), null);
  assert.throws(() => parseSteps({}), { code: 'ERR_BAD_INPUT' });
  assert.throws(() => parseSteps(Array.from({ length: 10_001 }, () => ({ slide: 'a', step: 0 }))), { code: 'ERR_BAD_INPUT' });
  const out = parseSteps([
    { slide: 'a', step: 0 }, { slide: '', step: 0 }, { slide: 'x'.repeat(201), step: 0 },
    { slide: 'b', step: 1.5 }, { slide: 'b', step: 2, extra: 1 }, null, { slide: 'c\n', step: 0 },
    { slide: 'd', step: -1 }, { slide: 'd', step: 10_000 },
  ]);
  assert.deepEqual(out, [{ slide: 'a', step: 0 }, { slide: 'b', step: 2 }]);
});

test('summarize counts kept notes and flags positional ids', () => {
  const slides = { s1: { notes: 'x' }, s2: { notes: '' }, s3: { steps: { 1: 'y' } }, gone: { notes: 'z' } };
  const s = summarize(slides, steps([['s1', 0], ['s2', 0], ['s3', 0], ['s3', 1]]));
  assert.equal(s.kept, 2);
  assert.deepEqual(s.removedSlides, ['gone']);
  assert.equal(s.positional, true);
  assert.equal(s.checked, true);

  assert.equal(summarize({ intro: { notes: 'x' } }, steps([['intro', 0], ['how', 0], ['end', 0]])).positional, false);
  assert.equal(summarize({ s1: { notes: 'x' } }, steps([['s1', 0], ['s2', 0]])).positional, false);
  assert.equal(summarize({}, steps([['s1', 0], ['s2', 0], ['s3', 0]])).positional, false);
  const u = summarize({ a: { notes: 'x' } }, null);
  assert.equal(u.checked, false);
  assert.equal(u.kept, 1);
});
