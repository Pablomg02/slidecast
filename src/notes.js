import { DeckError } from './decks.js';

// Which notes survive a new version of a deck, given the slides and steps the
// new version reports. Used for both the summary and the commit, so what the
// admin is shown is what happens.

const MAX_STEPS = 10_000;

function validSlideId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\0-\x1f]/.test(v);
}

// `[{slide, step}]` from the browser, or null when the deck could not report
// them. Items that can never carry notes are skipped.
export function parseSteps(input) {
  if (input === null) return null;
  if (!Array.isArray(input) || input.length > MAX_STEPS) {
    throw new DeckError('ERR_BAD_INPUT', 'steps must be a list');
  }
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || !validSlideId(item.slide)) continue;
    if (!Number.isInteger(item.step) || item.step < 0 || item.step > 9999) continue;
    out.push({ slide: item.slide, step: item.step });
  }
  return out;
}

function stepNotes(entry) {
  const s = entry?.steps;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
}

function hasNotes(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.notes === 'string' && entry.notes !== '') return true;
  const s = stepNotes(entry);
  return Boolean(s) && Object.keys(s).length > 0;
}

function stepsBySlide(steps) {
  const map = new Map();
  for (const { slide, step } of steps) {
    if (!map.has(slide)) map.set(slide, new Set());
    map.get(slide).add(step);
  }
  return map;
}

export function pruneSlides(slides, steps) {
  if (steps === null) return { slides, removedSlides: [], removedSteps: [] };
  const present = stepsBySlide(steps);
  const out = {};
  const removedSlides = [];
  const removedSteps = [];
  for (const [id, entry] of Object.entries(slides ?? {})) {
    if (!present.has(id)) {
      if (hasNotes(entry)) removedSlides.push(id);
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      out[id] = entry;
      continue;
    }
    const kept = { ...entry };
    const s = stepNotes(entry);
    if (s) {
      const nums = present.get(id);
      const keptSteps = {};
      for (const [k, v] of Object.entries(s)) {
        if (nums.has(Number(k))) keptSteps[k] = v;
        else removedSteps.push({ slide: id, step: Number(k) });
      }
      if (Object.keys(keptSteps).length) kept.steps = keptSteps;
      else delete kept.steps;
    }
    out[id] = kept;
  }
  return { slides: out, removedSlides, removedSteps };
}

// Ids like s1, s2, s3 shift when a slide is inserted (D9 of 0004).
function looksPositional(steps) {
  const ids = [...new Set(steps.map((s) => s.slide))];
  if (ids.length < 3) return false;
  const prefixes = new Set();
  for (const id of ids) {
    const m = /^(.*?)(\d+)$/.exec(id);
    if (!m) return false;
    prefixes.add(m[1]);
  }
  return prefixes.size === 1;
}

export function summarize(slides, steps) {
  const r = pruneSlides(slides, steps);
  const kept = Object.values(r.slides).filter(hasNotes).length;
  return {
    kept,
    removedSlides: r.removedSlides,
    removedSteps: r.removedSteps,
    positional: steps !== null && kept > 0 && looksPositional(steps),
    checked: steps !== null,
  };
}
