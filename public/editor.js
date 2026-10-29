// Notes editor: walk the deck step by step and write slide and step notes.
// Saved to deck.json through the admin API; the live hub is never touched.
import { t, el, api, setTitle, createDeckFrame, keyActionFromEvent, isOwnKey } from './shell.js';
import { renderMarkdown } from './markdown.js';

const slug = decodeURIComponent(location.pathname.split('/')[3] ?? '');
const app = document.getElementById('app');
const info = await api(`/api/decks/${encodeURIComponent(slug)}`);
if (!info.ok || !info.data.canAdmin) location.replace('/admin');
const deck = info.data;
setTitle(`${t('edit')} · ${deck.title}`);

const notes = structuredClone(deck.notes ?? {});
const dirty = new Set();
let index = 0;
let saveTimer = null;
let saving = false;

// ---- layout ----------------------------------------------------------------

const frameBox = el('div.e-frame');
const [aw, ah] = deck.aspect.split(':').map(Number);
frameBox.style.aspectRatio = `${aw} / ${ah}`;
const counter = el('span.p-counter', { id: 'counter' });
const stepList = el('nav.e-steps', { 'aria-label': t('steps') });
const slideLabel = el('label', { htmlFor: 'slide-notes' });
const stepLabel = el('label', { htmlFor: 'step-note' });
const slideArea = el('textarea', { id: 'slide-notes', rows: 8, spellcheck: true });
const stepArea = el('textarea', { id: 'step-note', rows: 4, spellcheck: true });
const preview = el('div.e-preview.p-notes-body', { id: 'preview' });
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
      el('h3.e-preview-title', {}, t('preview')), preview)),
);

const frame = createDeckFrame(frameBox, deck.deckUrl, { mode: 'live' });

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
      group = el('div.e-group', { dataset: { slide: s.slide } }, el('span.e-slide-id', {}, s.slide));
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
    const res = await api(`/api/admin/decks/${encodeURIComponent(slug)}/slides/${encodeURIComponent(slideId)}`, {
      method: 'PUT', body: { notes: slide.notes ?? '', steps: slide.steps ?? {} },
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
