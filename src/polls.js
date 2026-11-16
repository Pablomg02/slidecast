import { randomBytes } from 'node:crypto';
import { cleanLine } from './rooms.js';

// Polls (0006). The text of a poll lives in deck.json, next to the slide's
// notes (D1); what happens to it in a room (a "run": the text it was shown
// with, open or closed, the answers) lives in memory only (D6).

export const POLL_LIMITS = { question: 300, option: 150, options: 10 };
const MAX_RUNS = 100;

// Cleans a poll as written by the editor or in deck.json (D1). Returns
// {poll} — null when it says nothing — or {error} when it has the wrong shape.
// Answers left empty are dropped, so the editor may save a poll half written.
export function cleanPoll(raw) {
  if (raw === null || raw === undefined) return { poll: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'poll must be an object' };
  const { question = '', options = [], multiple = false } = raw;
  if (typeof question !== 'string' || question.length > 2000) return { error: 'invalid poll question' };
  if (!Array.isArray(options) || options.length > 50) return { error: 'invalid poll answers' };
  if (typeof multiple !== 'boolean') return { error: 'invalid poll kind' };
  const answers = [];
  for (const o of options) {
    if (typeof o !== 'string' || o.length > 1000) return { error: 'invalid poll answer' };
    const text = cleanLine(o, POLL_LIMITS.option);
    if (text) answers.push(text);
  }
  if (answers.length > POLL_LIMITS.options) return { error: 'too many poll answers' };
  const q = cleanLine(question, POLL_LIMITS.question);
  if (!q && !answers.length) return { poll: null };
  return { poll: { question: q, options: answers, multiple } };
}

// The poll of a slide entry of deck.json when it can be launched: a question
// and at least two answers. Anything else (absent, half written, invalid) is null.
export function pollOf(entry) {
  const { poll } = cleanPoll(entry && typeof entry === 'object' ? entry.poll : null);
  return poll && poll.question && poll.options.length >= 2 ? poll : null;
}

const sameText = (a, b) => a.question === b.question && a.multiple === b.multiple
  && a.options.length === b.options.length && a.options.every((o, i) => o === b.options[i]);

const newId = () => randomBytes(6).toString('hex');

// The polls of one room: a run per slide, at most one of them shown (D3).
// Answers are kept by participant id (`voter`), only to give each participant
// back its own answer and let it change it; nobody else ever sees them (D6).
export function createPolls() {
  const runs = new Map(); // slide id → run, oldest shown first
  let shown = null; // slide id of the run on the screens

  // A new text: the answers given for the old one no longer apply (D2).
  function define(run, def) {
    run.id = newId();
    run.question = def.question;
    run.options = [...def.options];
    run.multiple = def.multiple;
    run.ballots = new Map();
    run.counts = def.options.map(() => 0);
  }

  function shownRun() {
    return shown === null ? null : runs.get(shown) ?? null;
  }

  function publicRun(run) {
    return {
      slide: run.slide,
      id: run.id,
      question: run.question,
      options: run.options,
      multiple: run.multiple,
      open: run.open,
      counts: run.counts,
      voters: run.ballots.size,
    };
  }

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
        run = { slide, open: true };
        define(run, def);
      } else if (def && !run.ballots.size && !sameText(run, def)) {
        define(run, def);
      }
      runs.delete(slide); // the cap below drops the run shown longest ago
      runs.set(slide, run);
      for (const old of runs.keys()) {
        if (runs.size <= MAX_RUNS) break;
        if (old !== slide) runs.delete(old);
      }
      shown = slide;
      return true;
    },

    hide() {
      if (shown === null) return false;
      shown = null;
      return true;
    },

    // Answers accepted or not; false if nothing changed.
    setOpen(slide, on) {
      const run = runs.get(slide);
      if (!run || run.open === on) return false;
      run.open = on;
      return true;
    },

    // Clears the answers and takes the current text, open again. With no
    // text left in deck.json the run goes away.
    reset(slide, def) {
      const run = runs.get(slide);
      if (!run) return false;
      if (!def) {
        runs.delete(slide);
        if (shown === slide) shown = null;
        return true;
      }
      define(run, def);
      run.open = true;
      return true;
    },

    // New texts from deck.json (`slides`): runs nobody has answered yet take
    // them (D2), and go away, unless on the screens, when their poll is gone.
    // Returns true if any run changed.
    refresh(slides) {
      let changed = false;
      for (const run of [...runs.values()]) {
        if (run.ballots.size) continue;
        const def = pollOf(Object.hasOwn(slides ?? {}, run.slide) ? slides[run.slide] : null);
        if (!def && run.slide !== shown) {
          runs.delete(run.slide);
          changed = true;
        } else if (def && !sameText(run, def)) {
          define(run, def);
          changed = true;
        }
      }
      return changed;
    },

    // A participant's answer to the shown poll (D5). Returns an error code,
    // or null when it was counted.
    vote(voter, id, choice) {
      const run = shownRun();
      if (!run || run.id !== id) return 'poll-gone';
      if (!run.open) return 'poll-closed';
      const n = run.options.length;
      if (!Array.isArray(choice) || choice.length < 1 || choice.length > n) return 'bad-message';
      if (!run.multiple && choice.length !== 1) return 'bad-message';
      if (!choice.every((i) => Number.isInteger(i) && i >= 0 && i < n)) return 'bad-message';
      if (new Set(choice).size !== choice.length) return 'bad-message';
      const before = run.ballots.get(voter);
      if (before) for (const i of before) run.counts[i]--;
      const ballot = [...choice].sort((a, b) => a - b);
      run.ballots.set(voter, ballot);
      for (const i of ballot) run.counts[i]++;
      return null;
    },

    // A participant removed from the room: its answers go too (D5).
    forget(voter) {
      let changed = false;
      for (const run of runs.values()) {
        const ballot = run.ballots.get(voter);
        if (!ballot) continue;
        for (const i of ballot) run.counts[i]--;
        run.ballots.delete(voter);
        changed = true;
      }
      return changed;
    },

    clear() {
      runs.clear();
      shown = null;
    },

    // For presenters and displays: every run, counts only (D6, D7).
    forPresenters() {
      return { t: 'polls', shown, runs: [...runs.values()].map(publicRun) };
    },

    // For one participant: the shown poll, its own answer, and the results
    // once answers are closed (D7).
    forParticipant(voter) {
      const run = shownRun();
      if (!run) return { t: 'poll', poll: null, mine: null };
      return {
        t: 'poll',
        poll: {
          id: run.id,
          question: run.question,
          options: run.options,
          multiple: run.multiple,
          open: run.open,
          results: run.open ? null : { counts: run.counts, voters: run.ballots.size },
        },
        mine: run.ballots.get(voter) ?? null,
      };
    },
  };
}
