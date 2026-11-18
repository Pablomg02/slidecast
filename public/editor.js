// Notes editor: walk the deck step by step and write slide and step notes,
// and each slide's poll (0006). Saved to deck.json through the admin API; the
// live hub only hears of it to update presenters.
import {
  t, el, api, setTitle, createDeckFrame, keyActionFromEvent, isOwnKey, icon, confirmButton,
  parseAspect, parseLayout,
} from './shell.js';
import { renderMarkdown } from './markdown.js';
import { POLL_LIMITS, letter, pollOf, validCorrect } from './poll.js';

const slug = decodeURIComponent(location.pathname.split('/')[3] ?? '');
const app = document.getElementById('app');
const info = await api(`/api/decks/${encodeURIComponent(slug)}`);
if (!info.ok || !info.data.canAdmin) location.replace('/admin');
const deck = info.data;
setTitle(`${t('edit')} · ${deck.title}`);

const notes = structuredClone(deck.notes ?? {});
const dirty = new Set();
// Slides whose poll was changed here: only those send it, so saving notes
// never touches a poll written elsewhere meanwhile.
const pollTouched = new Set();
// Slides whose poll in deck.json was not valid (written by hand or by an AI):
// shown corrected, with a warning, and saved corrected with the next change.
const pollFixed = new Set();

// A poll from deck.json in a shape the form can hold (and the API accepts).
function editablePoll(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clip = (v, max) => [...v].slice(0, max).join('');
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .filter((o) => typeof o === 'string').slice(0, POLL_LIMITS.options).map((o) => clip(o, POLL_LIMITS.option));
  const question = typeof raw.question === 'string' ? clip(raw.question, POLL_LIMITS.question) : '';
  // Right answers (0007): positions of answers the form holds.
  const correct = validCorrect(raw.correct) ? [...new Set(raw.correct ?? [])].filter((i) => i < options.length) : [];
  return { question, options, multiple: raw.multiple === true, correct, ...contestFields(raw) };
}

// A poll's own contest fields (D3 of 0009), when valid: always carried, so
// editing a poll with contest mode off never loses them.
const validPoints = (v) => Number.isInteger(v) && v >= 1 && v <= 10000;
const validTime = (v) => v === null || (Number.isInteger(v) && v >= 5 && v <= 600);
function contestFields(raw) {
  const out = {};
  if (validPoints(raw.points)) out.points = raw.points;
  if (Object.hasOwn(raw, 'time') && validTime(raw.time)) out.time = raw.time;
  if (raw.contest === false) out.contest = false;
  return out;
}
const contestOf = (raw) => {
  const out = {};
  for (const k of ['points', 'time']) if (Object.hasOwn(raw, k)) out[k] = raw[k];
  if (Object.hasOwn(raw, 'contest') && raw.contest !== true) out.contest = raw.contest;
  return out;
};
for (const [id, entry] of Object.entries(notes)) {
  if (!entry || typeof entry !== 'object' || !('poll' in entry)) continue;
  const raw = entry.poll;
  const poll = editablePoll(raw);
  const same = poll && JSON.stringify(poll) === JSON.stringify({
    question: raw.question, options: raw.options, multiple: raw.multiple ?? false, correct: raw.correct ?? [], ...contestOf(raw),
  });
  if (!same) {
    pollFixed.add(id);
    pollTouched.add(id);
  }
  if (poll) entry.poll = poll;
  else delete entry.poll;
}
const hasPoll = (slideId) => {
  const p = notes[slideId]?.poll;
  return Boolean(p && (p.question.trim() || p.options.some((o) => o.trim())));
};
let index = 0;
let saveTimer = null;
let saving = false;

// ---- layout ----------------------------------------------------------------

const frameBox = el('div.e-frame');
const [aw, ah] = parseAspect(deck.aspect);
frameBox.style.aspectRatio = `${aw} / ${ah}`;
const counter = el('span.p-counter', { id: 'counter' });
const stepList = el('nav.e-steps', { 'aria-label': t('steps') });
const slideLabel = el('label', { htmlFor: 'slide-notes' });
const stepLabel = el('label', { htmlFor: 'step-note' });
const slideArea = el('textarea', { id: 'slide-notes', rows: 8, spellcheck: true });
const stepArea = el('textarea', { id: 'step-note', rows: 4, spellcheck: true });
const preview = el('div.e-preview.p-notes-body', { id: 'preview' });

// The slide's poll: hidden behind "Add a poll" until it has one.
const pollTitle = el('h3.e-poll-title');
const pollAdd = el('button', { type: 'button', id: 'poll-add', onclick: () => addPoll() }, icon('poll'), t('pollAdd'));
const pollQuestion = el('input', { type: 'text', id: 'poll-question', maxLength: POLL_LIMITS.question, autocomplete: 'off' });
const pollOptions = el('ol.e-poll-options', { id: 'poll-options' });
const pollAddOption = el('button.small', { type: 'button', id: 'poll-add-option', onclick: () => addOption() }, `+ ${t('pollAddOption')}`);
const kindSingle = el('input', { type: 'radio', name: 'poll-kind', id: 'poll-kind-single' });
const kindMultiple = el('input', { type: 'radio', name: 'poll-kind', id: 'poll-kind-multiple' });
const pollIncomplete = el('p.hint.e-poll-incomplete', { id: 'poll-incomplete' }, t('pollIncomplete'));
const pollCorrectHint = el('p.hint.e-poll-correct-hint', { id: 'poll-correct-hint' }, t('pollCorrectHint'));
const pollCorrectAny = el('p.hint.e-poll-correct-hint', { id: 'poll-correct-any', hidden: true }, t('pollCorrectAny'));
const pollFixedHint = el('p.hint.e-poll-incomplete', { id: 'poll-fixed', hidden: true }, t('pollFixedHint'));

// Contest fields of a poll with right answers (D28 of 0009).
const contest = deck.contestConfig ?? { on: false, points: 1000, time: 30, speed: 50 };
const pollPoints = el('input', {
  type: 'number', id: 'poll-points', min: 1, max: 10000, step: 1, placeholder: t('pollPointsDefault', { n: contest.points }),
});
const pollTimeMode = el('select', { id: 'poll-time-mode' },
  el('option', { value: 'default' }, contest.time === null ? t('pollTimeDefaultNone') : t('pollTimeDefault', { s: contest.time })),
  el('option', { value: 'none' }, t('pollTimeNone')),
  el('option', { value: 'custom' }, t('pollTimeCustom')));
const pollTime = el('input', { type: 'number', id: 'poll-time', min: 5, max: 600, step: 1, 'aria-label': t('pollTimeSeconds') });
const pollCounts = el('input', { type: 'checkbox', id: 'poll-counts' });
const pollWrongCost = el('p.hint', { id: 'poll-wrong-cost', hidden: true });
const pollRangeHint = el('p.hint.e-poll-incomplete', { id: 'poll-range', role: 'alert', hidden: true });
const pollContestOff = el('p.hint', { id: 'poll-contest-off', hidden: contest.on }, t('pollContestOff'));
const pollContestSet = el('fieldset.e-poll-contest', { id: 'poll-contest', disabled: !contest.on },
  el('div.row.e-poll-contest-row', {},
    el('label.inline', { htmlFor: 'poll-counts' }, pollCounts, ` ${t('pollCounts')}`)),
  el('div.row.e-poll-contest-row', {},
    el('div', {}, el('label', { htmlFor: 'poll-points' }, t('pollPoints')), pollPoints),
    el('div', {}, el('label', { htmlFor: 'poll-time-mode' }, t('pollTimeLabel')), el('div.row', {}, pollTimeMode, pollTime))),
  pollRangeHint,
  pollWrongCost);
const pollContestBox = el('div.e-poll-contest-box', {},
  el('p.e-poll-label', {}, t('pollContestLegend')), pollContestOff, pollContestSet);
const pollContestOpinion = el('p.hint', { id: 'poll-contest-opinion', hidden: true }, t('pollContestOpinion'));

// A value out of range is marked and not saved: the last valid one stays.
function markRange(input, ok, hint) {
  input.setAttribute('aria-invalid', String(!ok));
  input.setCustomValidity(ok ? '' : hint);
  pollRangeHint.hidden = !pollPoints.validationMessage && !pollTime.validationMessage;
  pollRangeHint.textContent = pollPoints.validationMessage || pollTime.validationMessage;
}

function contestEdited() {
  const poll = notes[pollFor]?.poll;
  if (!poll) return;
  const n = Number(pollPoints.value);
  const pointsOk = pollPoints.value === '' || validPoints(n);
  markRange(pollPoints, pointsOk, t('pollPointsRange'));
  if (pollPoints.value === '') delete poll.points;
  else if (pointsOk) poll.points = n;
  const mode = pollTimeMode.value;
  pollTime.hidden = mode !== 'custom';
  const s = Number(pollTime.value);
  const timeOk = mode !== 'custom' || (pollTime.value !== '' && validTime(s));
  markRange(pollTime, timeOk, t('pollTimeRange'));
  if (mode === 'none') poll.time = null;
  else if (mode === 'default') delete poll.time;
  else if (timeOk) poll.time = s;
  if (pollCounts.checked) delete poll.contest;
  else poll.contest = false;
  pollEdited();
}
pollPoints.addEventListener('input', contestEdited);
pollTimeMode.addEventListener('change', () => {
  if (pollTimeMode.value === 'custom' && pollTime.value === '') pollTime.value = String(contest.time ?? 30);
  contestEdited();
});
pollTime.addEventListener('input', contestEdited);
pollCounts.addEventListener('change', contestEdited);

function renderContest(poll) {
  pollPoints.value = poll.points ?? '';
  pollTimeMode.value = !Object.hasOwn(poll, 'time') ? 'default' : poll.time === null ? 'none' : 'custom';
  pollTime.value = poll.time ?? '';
  pollTime.hidden = pollTimeMode.value !== 'custom';
  pollCounts.checked = poll.contest !== false;
  for (const input of [pollPoints, pollTime]) {
    input.setCustomValidity('');
    input.removeAttribute('aria-invalid');
  }
  pollRangeHint.hidden = true;
}
const pollArmed = { key: null, until: 0 };
const pollFoot = el('div.row.e-poll-foot');
const pollFields = el('div.e-poll-fields', { hidden: true },
  el('label', { htmlFor: 'poll-question' }, t('pollQuestion')), pollQuestion,
  el('p.e-poll-label', { id: 'poll-options-label' }, t('pollOptionsLabel')),
  pollOptions,
  pollAddOption,
  pollCorrectHint,
  el('div.row.e-poll-kind', { role: 'radiogroup', 'aria-label': t('pollKind') },
    el('label.inline', { htmlFor: 'poll-kind-single' }, kindSingle, t('pollKindSingle')),
    el('label.inline', { htmlFor: 'poll-kind-multiple' }, kindMultiple, t('pollKindMultiple'))),
  pollCorrectAny,
  pollContestBox,
  pollContestOpinion,
  pollIncomplete,
  pollFoot);
const pollBox = el('section.e-poll', { id: 'poll-editor' },
  pollTitle, el('p.hint.e-poll-hint', {}, t('pollEditorHint')), pollFixedHint, pollAdd, pollFields);
const statusBtn = el('button.e-status', { id: 'save-status', type: 'button', disabled: true, onclick: () => saveAll() }, t('saved'));

app.append(
  el('header.admin-header', {},
    el('h1', {}, deck.title),
    el('div.row', {}, statusBtn, el('a.button', { href: '/admin' }, t('admin')))),
  el('div.e-layout', {},
    el('div.e-left', {},
      frameBox,
      el('div.row.e-nav', {},
        el('button', { id: 'prev', onclick: () => goTo(index - 1) }, '◀'),
        counter,
        el('button', { id: 'next', onclick: () => goTo(index + 1) }, '▶')),
      stepList),
    el('div.e-right', {},
      slideLabel, slideArea,
      stepLabel, stepArea,
      pollBox,
      el('h3.e-preview-title', {}, t('preview')), preview)),
);

const frame = createDeckFrame(frameBox, deck.deckUrl, { mode: 'live', virtual: parseLayout(deck.layout) });

// ---- navigation ------------------------------------------------------------

function current() {
  return frame.steps[index];
}

function goTo(i) {
  if (!frame.steps.length) return;
  index = Math.max(0, Math.min(frame.steps.length - 1, i));
  frame.go(index);
  render();
}

function buildStepList() {
  stepList.replaceChildren();
  let group = null;
  frame.steps.forEach((s, i) => {
    if (!group || group.dataset.slide !== s.slide) {
      const mark = icon('poll', 'icon e-poll-mark');
      mark.setAttribute('aria-label', t('poll'));
      group = el('div.e-group', { dataset: { slide: s.slide } }, el('span.e-slide-id', {}, s.slide), mark);
      stepList.append(group);
    }
    group.append(el('button.e-step', { type: 'button', dataset: { index: String(i) }, onclick: () => goTo(i) }, String(s.step)));
  });
}

function render() {
  const s = current();
  if (!s) return;
  counter.textContent = `${index + 1} / ${frame.steps.length}`;
  for (const b of stepList.querySelectorAll('.e-step')) b.classList.toggle('active', Number(b.dataset.index) === index);
  for (const g of stepList.querySelectorAll('.e-group')) g.classList.toggle('active', g.dataset.slide === s.slide);
  const slide = notes[s.slide] ?? {};
  slideLabel.textContent = t('slideNotes', { id: s.slide });
  stepLabel.textContent = t('stepNoteLabel', { k: s.step });
  slideArea.value = slide.notes ?? '';
  stepArea.value = slide.steps?.[String(s.step)] ?? '';
  renderPreview();
  if (pollFor !== s.slide) renderPoll();
}

// ---- the slide's poll (0006) ------------------------------------------------

let pollFor = null; // the slide the form shows, so moving between its steps keeps the focus

function markPolls() {
  for (const g of stepList.querySelectorAll('.e-group')) g.classList.toggle('has-poll', hasPoll(g.dataset.slide));
}

function renderPoll() {
  const s = current();
  if (!s) return;
  pollFor = s.slide;
  const poll = notes[s.slide]?.poll ?? null;
  pollTitle.textContent = t('pollEditorTitle', { id: s.slide });
  pollFixedHint.hidden = !pollFixed.has(s.slide);
  pollAdd.hidden = Boolean(poll);
  pollFields.hidden = !poll;
  if (!poll) return;
  pollQuestion.value = poll.question;
  kindSingle.checked = !poll.multiple;
  kindMultiple.checked = poll.multiple;
  buildOptions();
  renderContest(poll);
  pollFoot.replaceChildren(el('span.grow'),
    confirmButton(t('pollRemove'), t('pollConfirmRemove'), `remove:${s.slide}`, () => removePoll(), pollArmed));
  pollHints();
}

function pollHints() {
  const poll = notes[pollFor]?.poll;
  if (!poll) return;
  pollIncomplete.hidden = Boolean(pollOf({ poll }));
  pollAddOption.disabled = poll.options.length >= POLL_LIMITS.options;
  pollCorrectAny.hidden = poll.multiple || poll.correct.length < 2;
  // The contest fields belong to polls with right answers.
  const graded = poll.correct.length > 0;
  pollContestBox.hidden = !graded;
  pollContestOpinion.hidden = graded || !contest.on;
  const wrong = poll.options.length - poll.correct.length;
  pollWrongCost.hidden = !poll.multiple || !graded || wrong < 1;
  pollWrongCost.textContent = t('pollWrongCost', { w: wrong });
}

function buildOptions(focus = null) {
  const poll = notes[pollFor].poll;
  pollOptions.replaceChildren(...poll.options.map((text, i) => {
    const input = el('input', {
      type: 'text', value: text, maxLength: POLL_LIMITS.option, autocomplete: 'off',
      'aria-label': t('pollOptionN', { letter: letter(i) }), dataset: { index: String(i) },
    });
    input.addEventListener('input', () => {
      poll.options[i] = input.value;
      pollEdited();
    });
    // Enter goes on to the next answer, adding one at the end.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i === poll.options.length - 1) addOption();
      else pollOptions.querySelectorAll('input[type=text]')[i + 1]?.focus();
    });
    // Right or not (0007).
    const right = el('input', {
      type: 'checkbox', checked: poll.correct.includes(i), 'aria-label': t('pollCorrectN', { letter: letter(i) }),
      dataset: { correct: String(i) },
    });
    right.addEventListener('change', () => {
      poll.correct = poll.correct.filter((k) => k !== i);
      if (right.checked) poll.correct.push(i);
      poll.correct.sort((a, b) => a - b);
      right.closest('li').classList.toggle('e-poll-right', right.checked);
      pollEdited();
    });
    const remove = el('button.small.icon-btn.e-poll-remove-option', {
      type: 'button', title: t('pollRemoveOption', { letter: letter(i) }), 'aria-label': t('pollRemoveOption', { letter: letter(i) }),
      onclick: () => {
        poll.options.splice(i, 1);
        // The right answers after it move up with their answers.
        poll.correct = poll.correct.filter((k) => k !== i).map((k) => (k > i ? k - 1 : k));
        buildOptions(Math.min(i, poll.options.length - 1));
        pollEdited();
      },
    }, '×');
    return el(`li.e-poll-option${poll.correct.includes(i) ? '.e-poll-right' : ''}`, {}, el('span.poll-letter', {}, letter(i)), input,
      el('label.e-poll-correct', { title: t('pollCorrectN', { letter: letter(i) }) }, right, el('span', {}, t('pollRight'))), remove);
  }));
  if (focus !== null) (pollOptions.querySelectorAll('input[type=text]')[focus] ?? pollAddOption).focus();
}

function pollEdited() {
  const id = pollFor;
  if (!id) return;
  notes[id] = { ...(notes[id] ?? {}) };
  pollTouched.add(id);
  dirty.add(id);
  pollHints();
  markPolls();
  setStatus('saving', 'pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAll, 800);
}

function addPoll() {
  const id = current()?.slide;
  if (!id) return;
  notes[id] = { ...(notes[id] ?? {}), poll: { question: '', options: ['', ''], multiple: false, correct: [] } };
  pollFor = null;
  renderPoll();
  pollQuestion.focus();
}

function addOption() {
  const poll = notes[pollFor]?.poll;
  if (!poll || poll.options.length >= POLL_LIMITS.options) return;
  poll.options.push('');
  buildOptions(poll.options.length - 1);
  pollEdited();
}

function removePoll() {
  const id = pollFor;
  const slide = { ...(notes[id] ?? {}) };
  delete slide.poll;
  notes[id] = slide;
  pollEdited();
  pollFor = null;
  renderPoll();
  pollAdd.focus();
}

pollQuestion.addEventListener('input', () => {
  notes[pollFor].poll.question = pollQuestion.value;
  pollEdited();
});
pollQuestion.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  pollOptions.querySelector('input[type=text]')?.focus();
});
for (const radio of [kindSingle, kindMultiple]) {
  radio.addEventListener('change', () => {
    notes[pollFor].poll.multiple = kindMultiple.checked;
    pollEdited();
  });
}

function renderPreview() {
  const html = renderMarkdown(slideArea.value)
    + (stepArea.value ? `<hr>${renderMarkdown(stepArea.value)}` : '');
  preview.innerHTML = html;
}

// `?slide=<id>&step=<k>` (the presenter's "Edit notes") opens at that step,
// or at the slide's first step; by slide id, so it survives reordered slides.
function startIndex() {
  const q = new URLSearchParams(location.search);
  const id = q.get('slide');
  if (!id) return 0;
  const k = q.get('step');
  const exact = frame.steps.findIndex((s) => s.slide === id && String(s.step ?? '') === k);
  return exact >= 0 ? exact : Math.max(0, frame.steps.findIndex((s) => s.slide === id));
}

frame.onReady(() => {
  buildStepList();
  markPolls();
  goTo(startIndex());
});
frame.onInput((action) => {
  if (action === 'next') goTo(index + 1);
  else if (action === 'prev') goTo(index - 1);
  else if (action === 'first') goTo(0);
  else if (action === 'last') goTo(frame.steps.length - 1);
});
frame.onChanged((i, own) => {
  if (!own && i !== index) {
    index = i;
    render();
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveAll();
    return;
  }
  if (isOwnKey(e)) return;
  const action = keyActionFromEvent(e); // null inside the textareas
  if (!action || action === 'fullscreen') return; // F5 still reloads here
  e.preventDefault();
  if (action === 'next') goTo(index + 1);
  else if (action === 'prev') goTo(index - 1);
  else if (action === 'first') goTo(0);
  else if (action === 'last') goTo(frame.steps.length - 1);
});

// ---- editing and saving ----------------------------------------------------

function setStatus(key, kind) {
  statusBtn.textContent = t(key);
  statusBtn.dataset.state = kind;
  statusBtn.disabled = kind !== 'error';
}

function onEdit() {
  const s = current();
  if (!s) return;
  const slide = { ...(notes[s.slide] ?? {}) };
  slide.notes = slideArea.value;
  const steps = { ...(slide.steps ?? {}) };
  if (stepArea.value) steps[String(s.step)] = stepArea.value;
  else delete steps[String(s.step)];
  slide.steps = steps;
  notes[s.slide] = slide;
  dirty.add(s.slide);
  renderPreview();
  setStatus('saving', 'pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAll, 800);
}
slideArea.addEventListener('input', onEdit);
stepArea.addEventListener('input', onEdit);

async function saveAll() {
  clearTimeout(saveTimer);
  if (saving) {
    saveTimer = setTimeout(saveAll, 200);
    return;
  }
  if (!dirty.size) {
    setStatus('saved', 'ok');
    return;
  }
  saving = true;
  setStatus('saving', 'pending');
  let failed = false;
  for (const slideId of [...dirty]) {
    dirty.delete(slideId);
    const slide = notes[slideId];
    const body = { notes: slide.notes ?? '', steps: slide.steps ?? {} };
    if (pollTouched.has(slideId)) body.poll = slide.poll ?? null;
    const res = await api(`/api/admin/decks/${encodeURIComponent(slug)}/slides/${encodeURIComponent(slideId)}`, {
      method: 'PUT', body,
    }).catch(() => ({ ok: false }));
    if (!res.ok) {
      dirty.add(slideId);
      failed = true;
    }
  }
  saving = false;
  if (failed) setStatus('saveError', 'error');
  else if (dirty.size) saveAll();
  else setStatus('saved', 'ok');
}

window.addEventListener('beforeunload', (e) => {
  if (dirty.size || saving) {
    e.preventDefault();
    e.returnValue = t('unsaved');
  }
});
