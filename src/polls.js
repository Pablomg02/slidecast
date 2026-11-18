import { randomBytes } from 'node:crypto';
import { cleanLine } from './rooms.js';
import { performance } from 'node:perf_hooks';
import { cleanPollContest, CONTEST_DEFAULTS, correctness, pointsFor } from './contest.js';

// Polls (0006). The text of a poll lives in deck.json, next to the slide's
// notes (D1); what happens to it in a room (a "run": the text it was shown
// with, open or closed, the answers) lives in memory only (D6).

export const POLL_LIMITS = { question: 300, option: 150, options: 10 };
const MAX_RUNS = 100;
// Answers still taken this long after a countdown ends, for slow Wi-Fi (D9 of 0009).
export const GRACE_MS = 1000;

// Cleans a poll as written by the editor or in deck.json (D1). Returns
// {poll} — null when it says nothing — or {error} when it has the wrong shape.
// Answers left empty are dropped, so the editor may save a poll half written.
// `correct` (0007) lists the right answers by position in `options`; it
// follows its answers when empty ones are dropped, and is left out when the
// poll has no right answers (an opinion poll). Its contest fields (0009, D3)
// are kept when valid; an invalid one is an error when `strict` (the API),
// and is dropped otherwise (deck.json as found on disk).
export function cleanPoll(raw, { strict = false } = {}) {
  if (raw === null || raw === undefined) return { poll: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'poll must be an object' };
  const { question = '', options = [], multiple = false, correct = [] } = raw;
  if (typeof question !== 'string' || question.length > 2000) return { error: 'invalid poll question' };
  if (!Array.isArray(options) || options.length > 50) return { error: 'invalid poll answers' };
  if (typeof multiple !== 'boolean') return { error: 'invalid poll kind' };
  if (!Array.isArray(correct) || correct.length > 50 || !correct.every((i) => Number.isInteger(i) && i >= 0)) {
    return { error: 'invalid poll correct answers' };
  }
  const answers = [];
  const right = [];
  for (const [i, o] of options.entries()) {
    if (typeof o !== 'string' || o.length > 1000) return { error: 'invalid poll answer' };
    const text = cleanLine(o, POLL_LIMITS.option);
    if (!text) continue;
    if (correct.includes(i)) right.push(answers.length);
    answers.push(text);
  }
  if (answers.length > POLL_LIMITS.options) return { error: 'too many poll answers' };
  const q = cleanLine(question, POLL_LIMITS.question);
  if (!q && !answers.length) return { poll: null };
  const extra = cleanPollContest(raw, { strict });
  if (extra.error) return { error: extra.error };
  const poll = { question: q, options: answers, multiple };
  if (right.length) poll.correct = right;
  Object.assign(poll, extra.fields);
  return { poll };
}

// How a participant's answer fares against the right ones (0007): null when
// the poll has none or there is no answer. One answer: right if it is one of
// them. Several: right with exactly them, partial with only right ones but
// not all, wrong with any wrong one.
export function gradeOf(choice, correct, multiple) {
  if (!correct?.length || !choice?.length) return null;
  const hits = choice.filter((i) => correct.includes(i)).length;
  if (!multiple) return hits ? 'right' : 'wrong';
  if (hits < choice.length) return 'wrong';
  return hits === correct.length ? 'right' : 'partial';
}

// The poll of a slide entry of deck.json when it can be launched: a question
// and at least two answers. Anything else (absent, half written, invalid) is null.
export function pollOf(entry) {
  const { poll } = cleanPoll(entry && typeof entry === 'object' ? entry.poll : null);
  return poll && poll.question && poll.options.length >= 2 ? poll : null;
}

const sameText = (a, b) => a.question === b.question && a.multiple === b.multiple
  && a.options.length === b.options.length && a.options.every((o, i) => o === b.options[i]);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const newId = () => randomBytes(6).toString('hex');

// The polls of one room: a run per slide, at most one of them shown (D3).
// Answers are kept by participant id (`voter`), only to give each participant
// back its own answer and let it change it; nobody else ever sees them (D6).
//
// Contest mode (0009): `contest()` gives the deck's current settings. Each
// run has an open clock (ms answers have been open, paused while closed,
// D8) and each answer the clock when the server received it (D7), from
// `now`, a monotonic clock.
export function createPolls({ now = () => performance.now(), contest = () => CONTEST_DEFAULTS } = {}) {
  const runs = new Map(); // slide id → run, oldest shown first
  let shown = null; // slide id of the run on the screens
  let seq = 0; // order runs were created in (D18)
  let scoredSeq = 0; // order runs started to count in (D18)

  // A new text: the answers given for the old one no longer apply (D2).
  function define(run, def) {
    run.id = newId();
    run.seq = ++seq;
    run.question = def.question;
    run.options = [...def.options];
    run.multiple = def.multiple;
    run.correct = [...(def.correct ?? [])];
    setContestFields(run, def);
    run.ballots = new Map();
    run.stamps = new Map(); // voter → open clock when its answer arrived
    run.counts = def.options.map(() => 0);
    run.openMs = 0;
    run.openedAt = run.open ? now() : null;
    run.limit = run.open ? limitOf(run) : null;
    run.scored = false;
    run.scoredSeq = 0;
  }

  // A poll's own contest fields (D3): its points and countdown, or none, and
  // whether it stays out. Returns whether anything that scores changed.
  function setContestFields(run, def) {
    const points = def.points ?? null;
    const excluded = def.contest === false;
    const changed = run.points !== points || run.excluded !== excluded;
    run.points = points;
    run.excluded = excluded;
    run.time = Object.hasOwn(def, 'time') ? def.time : undefined; // used from the next opening
    return changed;
  }

  // Would count for the contest once closed with its results shown (D4).
  const graded = (run) => contest().on && run.correct.length > 0 && !run.excluded;
  const counts = (run) => graded(run) && run.scored && !run.open;
  const pointsOf = (run) => run.points ?? contest().points;

  // The countdown of a run, in ms, or null (D9).
  function limitOf(run) {
    if (!graded(run)) return null;
    const time = run.time !== undefined ? run.time : contest().time;
    return time === null ? null : time * 1000;
  }

  const clock = (run) => run.openMs + (run.open ? now() - run.openedAt : 0);
  const left = (run) => (run.open && run.limit !== null ? Math.max(0, run.limit - clock(run)) : null);

  function setOpenNow(run, on) {
    if (run.open === on) return;
    if (on) {
      run.openedAt = now();
      run.limit = limitOf(run);
    } else {
      run.openMs = clock(run);
      run.openedAt = null;
    }
    run.open = on;
  }

  // Results shown while answers are closed: the run counts from now on.
  function markScored(run) {
    if (run.open || !run.revealed || run.scored) return;
    run.scored = true;
    run.scoredSeq = ++scoredSeq;
  }

  function shownRun() {
    return shown === null ? null : runs.get(shown) ?? null;
  }

  // The right answers of a run follow deck.json even once answered, while its
  // text stays the same: a wrong answer key can be fixed in class (0007). So
  // do its points and whether it counts (0009).
  function rekey(run, def) {
    const next = def.correct ?? [];
    const contestChanged = setContestFields(run, def);
    if (sameList(run.correct, next)) return contestChanged;
    run.correct = [...next];
    return true;
  }

  // How right a ballot is: in contest mode from its correctness (D5 of 0009),
  // so the verdict always agrees with the points; otherwise as in 0007.
  function gradeIn(run, ballot) {
    if (!graded(run)) return gradeOf(ballot, run.correct, run.multiple);
    if (!ballot?.length) return null;
    const c = correctness(ballot, run.correct, run.multiple, run.options.length);
    return c >= 1 ? 'right' : c > 0 ? 'partial' : 'wrong';
  }

  // How many got it right, partly right or wrong; null without right answers.
  function grades(run) {
    if (!run.correct.length) return null;
    const g = { right: 0, partial: 0, wrong: 0 };
    for (const ballot of run.ballots.values()) g[gradeIn(run, ballot)]++;
    return g;
  }

  // The points of one participant in a run, with how they were made.
  function scoreIn(run, voter) {
    const choice = run.ballots.get(voter);
    const T = run.limit ?? clock(run);
    const run_ = { correct: run.correct, multiple: run.multiple, options: run.options.length, points: pointsOf(run), T };
    if (!choice) return { points: 0, c: 0, t: null, T, answered: false };
    return { ...pointsFor({ choice, at: run.stamps.get(voter) }, run_, contest()), answered: true };
  }

  // What every client may know of a run's contest side.
  function contestView(run) {
    if (!contest().on) return null;
    if (!graded(run)) return { counts: false };
    return { counts: true, points: pointsOf(run), speed: contest().speed, limit: run.limit ?? limitOf(run), left: left(run) };
  }

  function publicRun(run) {
    const c = clock(run);
    const limit = run.open ? run.limit : limitOf(run);
    return {
      slide: run.slide,
      id: run.id,
      question: run.question,
      options: run.options,
      multiple: run.multiple,
      correct: run.correct,
      open: run.open,
      revealed: run.revealed,
      counts: run.counts,
      voters: run.ballots.size,
      grades: grades(run),
      contest: contestView(run),
      left: left(run),
      // Reopening a used-up countdown is refused (D8 of 0009).
      timeUp: !run.open && graded(run) && limit !== null && c >= limit,
      scored: counts(run),
    };
  }

  // The right answers are made public only once answers close and the
  // presenter shows the results: nobody copies them while answering.
  const solved = (run) => run.revealed && !run.open && run.correct.length > 0;

  return {
    get shown() { return shownRun(); },
    get size() { return runs.size; },
    get: (slide) => runs.get(slide) ?? null,

    // Puts the slide's run on the screens, creating it from `def` (the poll
    // of deck.json, or null) if needed. False when there is nothing to show.
    show(slide, def) {
      let run = runs.get(slide);
      if (run && !def && !run.ballots.size) {
        // Its poll is gone from deck.json and nobody answered: nothing to keep.
        runs.delete(slide);
        if (shown === slide) shown = null;
        return false;
      }
      if (!run) {
        if (!def) return false;
        run = { slide, open: true, revealed: false };
        define(run, def);
      } else if (def && !run.ballots.size && !sameText(run, def)) {
        define(run, def);
      } else if (def && sameText(run, def)) {
        rekey(run, def);
      }
      runs.delete(slide); // the cap below drops the run shown longest ago
      runs.set(slide, run);
      for (const [old, r] of runs) {
        if (runs.size <= MAX_RUNS) break;
        // Runs that count stay: a long contest keeps its points (D23 of 0009).
        if (old !== slide && !counts(r)) runs.delete(old);
      }
      shown = slide;
      return true;
    },

    hide() {
      if (shown === null) return false;
      shown = null;
      return true;
    },

    // Answers accepted or not; false if nothing changed. Closing says
    // whether the results go public at the same time; reopening makes them
    // secret again, so a second round of answers is as blind as the first.
    // Reopening resumes the open clock; in contest mode a used-up countdown
    // cannot be reopened: 'time-up' (D8 of 0009).
    setOpen(slide, on, revealed = false) {
      const run = runs.get(slide);
      const next = on ? false : revealed;
      if (!run || (run.open === on && run.revealed === next)) return false;
      if (on && !run.open) {
        const limit = limitOf(run);
        if (limit !== null && clock(run) >= limit) return 'time-up';
      }
      setOpenNow(run, on);
      run.revealed = next;
      if (on) run.scored = false;
      markScored(run);
      return true;
    },

    // The results public (to participants and displays) or secret; false if
    // nothing changed. The presenters always see them.
    setRevealed(slide, on) {
      const run = runs.get(slide);
      if (!run || run.revealed === on) return false;
      run.revealed = on;
      markScored(run);
      return true;
    },

    // While the shown poll takes answers with its results public, what
    // participants follow as answers arrive: one message for all, counts
    // only (each one's own answer comes back with its ack). Null otherwise.
    liveCounts() {
      const run = shownRun();
      if (!run?.open || !run.revealed) return null;
      return { t: 'poll-counts', id: run.id, counts: run.counts, voters: run.ballots.size };
    },

    // As if never launched: the run and its answers go, and it leaves the
    // screens if it was on them. Launching it again takes the current text.
    reset(slide) {
      if (!runs.has(slide)) return false;
      runs.delete(slide);
      if (shown === slide) shown = null;
      return true;
    },

    // New texts from deck.json (`slides`): runs nobody has answered yet take
    // them (D2), and go away, unless on the screens, when their poll is gone.
    // Answered runs with the same text take only the new right answers (0007)
    // and contest fields (0009). Returns true if any run changed.
    refresh(slides) {
      let changed = false;
      for (const run of [...runs.values()]) {
        const def = pollOf(Object.hasOwn(slides ?? {}, run.slide) ? slides[run.slide] : null);
        if (run.ballots.size) {
          if (def && sameText(run, def) && rekey(run, def)) changed = true;
          continue;
        }
        if (!def && run.slide !== shown) {
          runs.delete(run.slide);
          changed = true;
        } else if (def && !sameText(run, def)) {
          define(run, def);
          changed = true;
        } else if (def && rekey(run, def)) {
          changed = true;
        }
      }
      return changed;
    },

    // The deck's contest settings changed: with contest off, countdowns stop
    // and answers stay open (D9 of 0009). A running countdown otherwise keeps
    // its limit until answers close.
    contestChanged() {
      if (contest().on) return;
      for (const run of runs.values()) if (run.open) run.limit = null;
    },

    // A participant's answer to the shown poll (D5), received at `at` (D7 of
    // 0009). Returns an error code, or null when it was counted.
    vote(voter, id, choice, at = now()) {
      const run = shownRun();
      if (!run || run.id !== id) return 'poll-gone';
      if (!run.open) return 'poll-closed';
      const n = run.options.length;
      if (!Array.isArray(choice) || choice.length < 1 || choice.length > n) return 'bad-message';
      if (!run.multiple && choice.length !== 1) return 'bad-message';
      if (!choice.every((i) => Number.isInteger(i) && i >= 0 && i < n)) return 'bad-message';
      if (new Set(choice).size !== choice.length) return 'bad-message';
      // Received while answers were closed and waiting behind "reopen": it
      // counts from the moment they opened again.
      const stamp = run.openMs + Math.max(0, at - run.openedAt);
      if (run.limit !== null && stamp >= run.limit + GRACE_MS) return 'poll-closed';
      const before = run.ballots.get(voter);
      if (before) for (const i of before) run.counts[i]--;
      const ballot = [...choice].sort((a, b) => a - b);
      run.ballots.set(voter, ballot);
      run.stamps.set(voter, stamp);
      for (const i of ballot) run.counts[i]++;
      return null;
    },

    // Open runs with a countdown: slide → ms until answers close by
    // themselves, grace included (D9, D10 of 0009).
    deadlines() {
      const out = new Map();
      for (const run of runs.values()) {
        if (run.open && run.limit !== null) out.set(run.slide, Math.max(0, run.limit + GRACE_MS - clock(run)));
      }
      return out;
    },

    // The countdown ran out: answers close with the results secret. True if
    // it did.
    expire(slide) {
      const run = runs.get(slide);
      if (!run?.open || run.limit === null || clock(run) < run.limit) return false;
      setOpenNow(run, false);
      run.revealed = false;
      return true;
    },

    // Whether the shown run is graded for the contest, takes answers, and
    // every one of `voters` has answered it (D11 of 0009).
    allAnswered(voters) {
      const run = shownRun();
      if (!run?.open || !graded(run) || !voters.length) return false;
      return voters.every((v) => run.ballots.has(v));
    },

    // Closes the shown run with the results secret (everyone answered).
    closeShown() {
      const run = shownRun();
      if (!run?.open) return false;
      setOpenNow(run, false);
      run.revealed = false;
      return true;
    },

    // Whether a participant answered any poll of the room.
    hasAnswered(voter) {
      for (const run of runs.values()) if (run.ballots.has(voter)) return true;
      return false;
    },

    // Graded runs closed with their results not shown yet: they do not
    // count until they are (D19 of 0009).
    unscored() {
      return [...runs.values()].filter((r) => graded(r) && !r.open && !r.scored).map((r) => r.slide);
    },

    // The contest's points (D6 of 0009): `runs` that count, in creation
    // order, and per voter its total, how many it answered and got right,
    // and its points in each run (by run id).
    scores() {
      const counted = [...runs.values()].filter(counts).sort((a, b) => a.seq - b.seq);
      const voters = new Map();
      for (const run of counted) {
        for (const voter of run.ballots.keys()) {
          if (!voters.has(voter)) voters.set(voter, { voter, points: 0, answered: 0, right: 0, per: {} });
        }
      }
      for (const v of voters.values()) {
        for (const run of counted) {
          const s = scoreIn(run, v.voter);
          v.per[run.id] = s;
          v.points += s.points;
          if (s.answered) v.answered++;
          if (s.c >= 1) v.right++;
        }
      }
      const runsOut = counted.map((r) => ({ id: r.id, slide: r.slide, seq: r.seq, scoredSeq: r.scoredSeq, question: r.question }));
      return { runs: runsOut, voters: [...voters.values()] };
    },

    // A participant removed from the room: its answers go too (D5).
    forget(voter) {
      let changed = false;
      for (const run of runs.values()) {
        const ballot = run.ballots.get(voter);
        if (!ballot) continue;
        for (const i of ballot) run.counts[i]--;
        run.ballots.delete(voter);
        run.stamps.delete(voter);
        changed = true;
      }
      return changed;
    },

    clear() {
      runs.clear();
      shown = null;
    },

    // For presenters: every run, counts only (D6, D7 of 0006).
    forPresenters() {
      return { t: 'polls', shown, runs: [...runs.values()].map(publicRun) };
    },

    // For displays (the projector): only the shown poll, and its counts only
    // once the presenter makes them public, so the screen in the room never
    // tells what people are answering.
    forDisplays() {
      const run = shownRun();
      if (!run) return { t: 'polls', shown: null, runs: [] };
      const key = solved(run);
      return {
        t: 'polls',
        shown,
        runs: [{
          slide: run.slide,
          id: run.id,
          question: run.question,
          options: run.options,
          multiple: run.multiple,
          open: run.open,
          revealed: run.revealed,
          voters: run.ballots.size,
          counts: run.revealed ? run.counts : null,
          correct: key ? run.correct : [],
          grades: key ? grades(run) : null,
          contest: contestView(run),
          left: left(run),
        }],
      };
    },

    // For one participant: the shown poll, its own answer, and the results
    // once the presenter makes them public (D1 of 0008) — with the right answers and
    // how its own answer fared only once answers are closed too (0007), and
    // in contest mode its points and how they were made (D25 of 0009).
    forParticipant(voter) {
      const run = shownRun();
      if (!run) return { t: 'poll', poll: null, mine: null };
      const mine = run.ballots.get(voter) ?? null;
      const graded_ = solved(run);
      const view = contestView(run);
      if (view?.counts) {
        // Points of a question that counted are on hold while it is reopened.
        view.held = run.open && run.scoredSeq > 0;
        if (counts(run)) view.score = scoreIn(run, voter);
      }
      return {
        t: 'poll',
        poll: {
          id: run.id,
          question: run.question,
          options: run.options,
          multiple: run.multiple,
          open: run.open,
          revealed: run.revealed,
          contest: view,
          left: left(run),
          results: !run.revealed ? null : {
            counts: run.counts,
            voters: run.ballots.size,
            ...(graded_ ? { correct: run.correct, grades: grades(run), grade: gradeIn(run, mine) } : {}),
          },
        },
        mine,
      };
    },
  };
}
