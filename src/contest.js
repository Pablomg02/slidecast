// Contest mode (0009): a deck's graded polls score points and make a ranking.
// The settings live in deck.json under `contest` (D1, D2); a poll may
// override its points and countdown, or stay out (D3).

export const CONTEST_DEFAULTS = Object.freeze({ on: false, points: 1000, time: 30, speed: 50 });
export const CONTEST_LIMITS = Object.freeze({ points: [1, 10_000], time: [5, 600], speed: [0, 100] });

const inRange = (v, key) => Number.isInteger(v) && v >= CONTEST_LIMITS[key][0] && v <= CONTEST_LIMITS[key][1];
const validTime = (v) => v === null || inRange(v, 'time');

const CONTEST_FIELDS = {
  on: (v) => typeof v === 'boolean',
  points: (v) => inRange(v, 'points'),
  time: validTime,
  speed: (v) => inRange(v, 'speed'),
};

// The deck's contest settings. Missing fields take the default. Strict (the
// admin API): any invalid field is an error. Lenient (deck.json as found on
// disk, maybe written by hand): an invalid field takes its default (D2).
export function cleanContest(raw, { strict = false } = {}) {
  const contest = { ...CONTEST_DEFAULTS };
  if (raw === undefined || raw === null) return { contest };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return strict ? { error: 'contest must be an object' } : { contest };
  }
  for (const [key, valid] of Object.entries(CONTEST_FIELDS)) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) continue;
    if (valid(raw[key])) contest[key] = raw[key];
    else if (strict) return { error: `invalid contest ${key}` };
  }
  return { contest };
}

// The contest settings of a deck's meta, never an error.
export function contestOf(meta) {
  return cleanContest(meta && typeof meta === 'object' ? meta.contest : null).contest;
}

// A poll's own contest fields (D3): `points`, `time` (null: no countdown),
// `contest: false` (does not count). Returns {fields} with the valid ones
// present in `raw`, or {error} when strict and one is invalid.
export function cleanPollContest(raw, { strict = false } = {}) {
  const fields = {};
  const checks = {
    points: (v) => inRange(v, 'points'),
    time: validTime,
    contest: (v) => typeof v === 'boolean',
  };
  for (const [key, valid] of Object.entries(checks)) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) continue;
    if (!valid(raw[key])) {
      if (strict) return { error: `invalid poll ${key}` };
      continue;
    }
    if (key === 'contest' && raw[key] === true) continue; // counting is the default
    fields[key] = raw[key];
  }
  return { fields };
}

// ---- scoring (D5, D6) ------------------------------------------------------------

// How right a ballot is, from 0 to 1 (D5): one answer → 1 if it is a right
// one; several → right ones chosen over all right ones, minus wrong ones
// chosen over all wrong ones, never below 0.
export function correctness(choice, correct, multiple, options) {
  if (!choice?.length || !correct?.length) return 0;
  const hits = choice.filter((i) => correct.includes(i)).length;
  if (!multiple) return hits ? 1 : 0;
  const misses = choice.length - hits;
  const wrong = options - correct.length;
  return Math.max(0, hits / correct.length - (wrong > 0 ? misses / wrong : 0));
}

// The points of one ballot (D6): P · c · (1 − speed · t/T), rounded. `at` is
// the open clock (ms) when the ballot was received, `T` the countdown limit
// or, without one, how long answers were open. Returns the parts too, so the
// phone can explain the points.
export function pointsFor({ choice, at }, { correct, multiple, options, points, T }, { speed }) {
  const c = correctness(choice, correct, multiple, options);
  const t = Math.min(Math.max(at ?? 0, 0), T);
  const late = T > 0 ? t / T : 0;
  return { points: Math.round(points * c * (1 - (speed / 100) * late)), c, t, T };
}

// The ranking (D17): `scores` is [{voter, points, ...}], `people` finds a
// participant by id ({n, name}). Sorted by points, then name (null names
// last); equal points share a place (1, 2, 2, 4).
export function rankingOf(scores, personOf) {
  const rows = scores.map((s) => {
    const p = personOf(s.voter);
    return { ...s, n: p?.n ?? null, name: p?.name ?? null };
  });
  rows.sort((a, b) => b.points - a.points
    || (a.name === null) - (b.name === null)
    || (a.name ?? '').localeCompare(b.name ?? '')
    || (a.n ?? 0) - (b.n ?? 0));
  let pos = 0;
  rows.forEach((r, i) => {
    if (i === 0 || r.points !== rows[i - 1].points) pos = i + 1;
    r.pos = pos;
  });
  return rows;
}

// A spreadsheet cell (D21): quoted, quotes doubled, and a leading ' before
// anything a spreadsheet would run as a formula.
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
