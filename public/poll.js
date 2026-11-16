// Polls (0006), shared by the presenter view, the viewer and the editor: the
// rules for a poll that can be launched, and the results as bars.
import { t, el } from './shell.js';

export const POLL_LIMITS = { question: 300, option: 150, options: 10 };

// The same cleaning as the server (cleanLine in src/rooms.js), so the presenter
// view tells "edited since launched" apart from mere spacing.
const CONTROL = /(?!\u200d)[\p{Cc}\p{Cf}\u2028\u2029]/gu;
function cleanLine(v, max) {
  const s = String(v).normalize('NFC').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}

// The poll of a slide entry of deck.json when it can be launched (D1 of
// 0006): a question and 2–10 answers. Otherwise null.
export function pollOf(entry) {
  const raw = entry && typeof entry === 'object' ? entry.poll : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.question !== 'string' || raw.question.length > 2000) return null;
  if (!Array.isArray(raw.options) || raw.options.length > 50) return null;
  if (raw.multiple !== undefined && typeof raw.multiple !== 'boolean') return null;
  if (raw.options.some((o) => typeof o !== 'string' || o.length > 1000)) return null;
  const options = raw.options.map((o) => cleanLine(o, POLL_LIMITS.option)).filter(Boolean);
  const question = cleanLine(raw.question, POLL_LIMITS.question);
  if (!question || options.length < 2 || options.length > POLL_LIMITS.options) return null;
  return { question, options, multiple: raw.multiple === true };
}

export function samePoll(a, b) {
  return a.question === b.question && a.multiple === b.multiple
    && a.options.length === b.options.length && a.options.every((o, i) => o === b.options[i]);
}

// A, B, C… so the room can talk about the answers.
export const letter = (i) => String.fromCharCode(65 + i);

// "1 answer", "2 answers".
export const answers = (n) => t(n === 1 ? 'pollAnswer1' : 'pollAnswers', { n });

const percent = (count, voters) => (voters ? Math.round((100 * count) / voters) : 0);

// Results as bars: {element, update({options, counts, voters}, {mine})}.
// While the options stay the same, the bars are updated in place, so they
// grow smoothly as answers arrive.
export function createResults() {
  const list = el('ol.poll-results');
  let key = null;
  let rows = [];

  function build(options) {
    rows = options.map((text, i) => {
      const count = el('span.poll-count');
      const fill = el('span.poll-fill');
      const mineMark = el('span.poll-mine', { hidden: true }, t('pollYourAnswer'));
      const li = el('li.poll-result', {},
        el('div.poll-result-label', {}, el('span.poll-letter', {}, letter(i)), el('span.poll-text', {}, text), mineMark, count),
        el('div.poll-bar', { 'aria-hidden': 'true' }, fill));
      return { li, count, fill, mineMark };
    });
    list.replaceChildren(...rows.map((r) => r.li));
  }

  return {
    element: list,
    update({ options, counts, voters }, { mine = null } = {}) {
      const k = JSON.stringify(options);
      if (k !== key) {
        key = k;
        build(options);
      }
      const top = Math.max(0, ...counts);
      rows.forEach((r, i) => {
        const n = counts[i] ?? 0;
        const pct = percent(n, voters);
        r.count.textContent = t('pollCount', { n, pct });
        r.fill.style.setProperty('--pct', `${pct}%`);
        r.li.classList.toggle('poll-lead', top > 0 && n === top);
        const own = Boolean(mine?.includes(i));
        r.li.classList.toggle('poll-own', own);
        r.mineMark.hidden = !own;
      });
    },
  };
}
