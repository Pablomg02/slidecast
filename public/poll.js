// Polls (0006), shared by the presenter view, the viewer and the editor: the
// rules for a poll that can be launched, and the results as bars.
import { t, el, icon } from './shell.js';

export const POLL_LIMITS = { question: 300, option: 150, options: 10 };

// The same cleaning as the server (cleanLine in src/rooms.js), so the presenter
// view tells "edited since launched" apart from mere spacing.
const CONTROL = /(?!\u200d)[\p{Cc}\p{Cf}\u2028\u2029]/gu;
function cleanLine(v, max) {
  const s = String(v).normalize('NFC').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}

// Right answers as deck.json may hold them (0007): positions in `options`.
export const validCorrect = (c) => c === undefined
  || (Array.isArray(c) && c.length <= 50 && c.every((i) => Number.isInteger(i) && i >= 0));

// The poll of a slide entry of deck.json when it can be launched (D1 of
// 0006): a question and 2–10 answers. Otherwise null. Its right answers
// (0007) follow their answers when empty ones are dropped, as on the server.
export function pollOf(entry) {
  const raw = entry && typeof entry === 'object' ? entry.poll : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.question !== 'string' || raw.question.length > 2000) return null;
  if (!Array.isArray(raw.options) || raw.options.length > 50) return null;
  if (raw.multiple !== undefined && typeof raw.multiple !== 'boolean') return null;
  if (raw.options.some((o) => typeof o !== 'string' || o.length > 1000)) return null;
  if (!validCorrect(raw.correct)) return null;
  const options = [];
  const correct = [];
  raw.options.forEach((o, i) => {
    const text = cleanLine(o, POLL_LIMITS.option);
    if (!text) return;
    if (raw.correct?.includes(i)) correct.push(options.length);
    options.push(text);
  });
  const question = cleanLine(raw.question, POLL_LIMITS.question);
  if (!question || options.length < 2 || options.length > POLL_LIMITS.options) return null;
  const poll = { question, options, multiple: raw.multiple === true };
  if (correct.length) poll.correct = correct;
  return poll;
}

export function samePoll(a, b) {
  return a.question === b.question && a.multiple === b.multiple
    && a.options.length === b.options.length && a.options.every((o, i) => o === b.options[i]);
}

// A, B, C… so the room can talk about the answers.
export const letter = (i) => String.fromCharCode(65 + i);

// "1 answer", "2 answers".
export const answers = (n) => t(n === 1 ? 'pollAnswer1' : 'pollAnswers', { n });

// "Correct: 3 · Partly correct: 1 · Incorrect: 2" (0007); partly only when
// several answers may be chosen.
export function gradesText(grades, multiple) {
  if (!grades) return '';
  return t(multiple ? 'pollGrades' : 'pollGradesSingle', grades);
}

const percent = (count, voters) => (voters ? Math.round((100 * count) / voters) : 0);

// Results as bars: {element, update({options, counts, voters}, {mine, correct})}.
// While the options stay the same, the bars are updated in place, so they
// grow smoothly as answers arrive. With `correct` (0007), the right answers
// are marked instead of the leading one, and a wrong answer of one's own too.
// Without `counts` (results not public yet), only the answers are listed.
export function createResults() {
  const list = el('ol.poll-results');
  let key = null;
  let rows = [];

  function build(options) {
    rows = options.map((text, i) => {
      const count = el('span.poll-count');
      const fill = el('span.poll-fill');
      const bar = el('div.poll-bar', { 'aria-hidden': 'true' }, fill);
      const mineMark = el('span.poll-mine', { hidden: true }, t('pollYourAnswer'));
      const rightMark = el('span.poll-right-mark', { hidden: true }, icon('check'), el('span', {}, t('pollRight')));
      const li = el('li.poll-result', {},
        el('div.poll-result-label', {}, el('span.poll-letter', {}, letter(i)), el('span.poll-text', {}, text), rightMark, mineMark, count),
        bar);
      return { li, count, bar, fill, mineMark, rightMark };
    });
    list.replaceChildren(...rows.map((r) => r.li));
  }

  return {
    element: list,
    update({ options, counts, voters }, { mine = null, correct = null } = {}) {
      const k = JSON.stringify(options);
      if (k !== key) {
        key = k;
        build(options);
      }
      const secret = !counts;
      const top = Math.max(0, ...(counts ?? []));
      const keyed = Boolean(correct?.length);
      list.classList.toggle('poll-keyed', keyed);
      rows.forEach((r, i) => {
        const n = counts?.[i] ?? 0;
        const pct = percent(n, voters);
        r.count.hidden = secret;
        r.bar.hidden = secret;
        r.count.textContent = secret ? '' : t('pollCount', { n, pct });
        r.fill.style.setProperty('--pct', `${pct}%`);
        r.li.classList.toggle('poll-lead', !secret && !keyed && top > 0 && n === top);
        const right = keyed && correct.includes(i);
        r.li.classList.toggle('poll-right', right);
        r.rightMark.hidden = !right;
        const own = Boolean(mine?.includes(i));
        r.li.classList.toggle('poll-own', own);
        r.li.classList.toggle('poll-own-wrong', own && keyed && !right);
        r.mineMark.hidden = !own;
      });
    },
  };
}
