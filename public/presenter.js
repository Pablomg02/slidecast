// Presenter view: current step, next step, notes, timer and controls.
// Desktop (≥ 900 px) shows the next-step preview, with dividers to resize the
// three boxes; the phone layout does not create it at all and shows large
// prev/next buttons instead.
import {
  t, el, api, slugFromPath, setTitle, connectLive, createDeckFrame, keyActionFromEvent,
  toggleFullscreen, isOwnKey, icon, acceptKey,
} from './shell.js';
import { renderMarkdown } from './markdown.js';
import { createRoomPanels } from './presenter-room.js';

const slug = slugFromPath();
const app = document.getElementById('app');
const info = await api(`/api/decks/${encodeURIComponent(slug)}`);
if (!info.ok || !info.data.canPresent) location.replace(`/${slug}/login?as=presenter`);
const deck = info.data;
setTitle(deck.title);

const [aw, ah] = deck.aspect.split(':').map(Number);
const desktop = window.matchMedia('(min-width: 900px)');
const live = { index: 0, total: 0, blank: false, viewerNav: deck.viewerNav };
let notes = deck.notes ?? {};

// ---- layout ----------------------------------------------------------------

const currentBox = el('div.p-frame.p-current');
const nextBox = el('div.p-frame.p-next');
const endCard = el('div.p-end', { hidden: true }, t('end'));
nextBox.append(endCard);
for (const box of [currentBox, nextBox]) box.style.aspectRatio = `${aw} / ${ah}`;
app.style.setProperty('--ar', String(aw / ah));
// The next step sits in a slot the row divider sizes; the box keeps its ratio inside.
const nextSlot = el('div.p-next-slot', {}, nextBox);

const counter = el('span.p-counter', { id: 'counter' }, '–');
const slideId = el('span.p-slide-id', { id: 'slide-id' });
const notesBody = el('div.p-notes-body', { id: 'notes' });
const reconnecting = el('span.badge.badge-warn', { hidden: true }, t('reconnecting'));

const btnPrev = el('button.p-prev', { id: 'prev', title: t('prev'), onclick: () => act('prev') }, '◀', el('span.label', {}, t('prev')));
const btnNext = el('button.p-next-btn', { id: 'next', title: t('next'), onclick: () => act('next') }, el('span.label', {}, t('next')), '▶');
const btnBlank = el('button', { id: 'blank', onclick: () => act('blank') }, t('blank'));
const modeSelect = el('select', { id: 'viewer-mode', title: t('viewerMode'), onchange: () => conn.send({ t: 'nav', mode: modeSelect.value }) },
  el('option', { value: 'follow' }, t('modeFollow')),
  el('option', { value: 'back' }, t('modeBack')),
  el('option', { value: 'free' }, t('modeFree')));
// The tooltip says what the chosen mode lets viewers do.
const MODE_HINTS = { follow: 'modeFollowHint', back: 'modeBackHint', free: 'modeFreeHint' };
const describeMode = () => { modeSelect.title = `${t('viewerMode')}: ${t(MODE_HINTS[modeSelect.value])}`; };
modeSelect.addEventListener('change', describeMode);
const viewers = el('span.p-viewers', { id: 'viewers' }, t('viewersCount', { n: 0 }));
const roomClosed = el('span.badge.badge-warn.p-room-closed', { id: 'room-closed', hidden: true }, t('roomClosedBadge'));
// Only the admin opens and closes rooms (D3 of 0003); closing asks once more.
let closeArmed = 0;
let roomErrorUntil = 0;
const roomBtn = el('button', { id: 'room-toggle', hidden: !deck.canAdmin, onclick: () => toggleRoom() });
const clock = el('span.p-clock', { id: 'clock' });
const timerText = el('span.p-timer-text', { id: 'timer' }, '00:00');
const timerToggle = el('button', { id: 'timer-toggle', onclick: () => toggleTimer() }, t('start'));
const timerReset = el('button', { id: 'timer-reset', onclick: () => resetTimer() }, t('reset'));
const fontMinus = el('button', { title: t('fontSmaller'), onclick: () => setFont(fontSize - 2) }, 'A−');
const fontPlus = el('button', { title: t('fontBigger'), onclick: () => setFont(fontSize + 2) }, 'A+');
const fontSteps = el('span.p-font-steps', { hidden: true }, fontMinus, fontPlus);
const fontToggle = el('button.p-font-toggle', {
  title: t('textSize'), 'aria-expanded': 'false',
  onclick: () => {
    fontSteps.hidden = !fontSteps.hidden;
    fontToggle.setAttribute('aria-expanded', String(!fontSteps.hidden));
  },
}, 'Aa');
const openViewer = el('a.button', { href: `/${slug}/view`, target: '_blank', rel: 'noopener' }, t('openViewer'));
// Admins only: the notes editor, opened at the step being presented (render() keeps the link current).
const editNotes = el('a.button', { id: 'edit-notes', href: `/admin/edit/${encodeURIComponent(slug)}`, hidden: !deck.canAdmin, target: '_blank', rel: 'noopener' }, t('edit'));

// Phone only: fold the current slide away to give the notes more room.
const slideToggle = el('button.p-slide-toggle', { id: 'slide-toggle', onclick: () => setSlideFolded(!slideFolded) },
  icon('chevron'), el('span.label'));

// Notes, raised hands and people share the side panel, as tabs.
const panels = createRoomPanels({ send: (msg) => conn.send(msg) });
const handsCount = el('span.p-tab-count', { hidden: true });
const tabs = {
  notes: el('button.p-tab', { type: 'button', role: 'tab', id: 'tab-notes', onclick: () => setTab('notes') }, t('notes')),
  hands: el('button.p-tab', { type: 'button', role: 'tab', id: 'tab-hands', onclick: () => setTab('hands') }, t('tabHands'), handsCount),
  people: el('button.p-tab', { type: 'button', role: 'tab', id: 'tab-people', onclick: () => setTab('people') }, t('tabPeople')),
};
const fontBox = el('div.p-font', {}, fontSteps, fontToggle);

// The slide id lives above the notes, not in the toolbar, so its changing
// width never shifts the toolbar.
const notesBox = el('section.p-notes', {},
  el('div.p-notes-head', {}, el('div.p-tabs', { role: 'tablist' }, Object.values(tabs)), roomClosed, slideId, slideToggle),
  notesBody,
  panels.handsPanel,
  panels.peoplePanel,
  fontBox);

// Phone only: clock, viewer settings and blank stay folded behind this button.
const moreToggle = el('button.p-more-toggle', {
  id: 'more', title: t('more'), 'aria-expanded': 'false',
  onclick: () => {
    const open = toolbar.classList.toggle('p-more-open');
    moreToggle.setAttribute('aria-expanded', String(open));
  },
}, icon('more', 'icon icon-fill'));

const toolbar = el('div.p-toolbar', {},
  el('div.p-group.p-nav', {}, btnPrev, counter, btnNext),
  el('div.p-group.p-timer', {}, timerText, timerToggle, timerReset, moreToggle),
  el('div.p-group.p-secondary', {}, clock),
  el('div.p-group.p-secondary', {}, modeSelect, viewers),
  el('div.p-group.p-secondary', {}, btnBlank, roomBtn),
  el('div.p-group.p-extra', {}, openViewer, editNotes),
  reconnecting);

const colSplit = el('div.p-split.p-split-cols', {
  role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-valuemin': 0, 'aria-valuemax': 100,
  'aria-label': t('resizeSlide'), title: t('resizeHint'),
});
const rowSplit = el('div.p-split.p-split-rows', {
  role: 'separator', tabIndex: 0, 'aria-orientation': 'horizontal', 'aria-valuemin': 0, 'aria-valuemax': 100,
  'aria-label': t('resizeNext'), title: t('resizeHint'),
});
const mainBox = el('div.p-main', {}, currentBox);
const side = el('div.p-side', {}, nextSlot, rowSplit, notesBox);
app.append(mainBox, colSplit, side, toolbar);

// ---- resizing (desktop) ----------------------------------------------------

// Two dividers: slide | side column, and next step / notes. Sizes are kept as
// fractions so they follow the window; the CSS keeps the same minimum sizes.
// `next` is the share of the column's height the next step may take, up to
// what the column's width allows (1 = as big as it fits, the default).
const GAP = 14;
const MIN = { main: 280, side: 260, next: 60, notes: 120 };
const DEFAULT_SIZES = { main: 0.6, next: 1 };
const sizes = { ...DEFAULT_SIZES };
const between = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
try {
  const saved = JSON.parse(localStorage.getItem('slidecast.presenterSizes')) ?? {};
  const fine = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;
  if (fine(saved.main, 0.1, 0.9)) sizes.main = saved.main;
  if (fine(saved.next, 0.05, 1)) sizes.next = saved.next;
} catch { /* storage blocked or a bad value */ }

function applySizes() {
  // Whole numbers of fr: fractions summing to less than 1 would leave space unused.
  app.style.setProperty('--p-main', `${sizes.main * 100}fr`);
  app.style.setProperty('--p-side', `${(1 - sizes.main) * 100}fr`);
  app.style.setProperty('--p-next', String(sizes.next));
}

function measure() {
  const m = mainBox.getBoundingClientRect();
  const s = side.getBoundingClientRect();
  return {
    left: m.left, mainW: m.width, sideW: s.width, total: m.width + s.width,
    top: s.top, avail: s.height - GAP, nextH: nextSlot.getBoundingClientRect().height,
  };
}

function setMainWidth(px, g) {
  sizes.main = between(px, MIN.main, g.total - MIN.side) / g.total;
}

// A taller next step needs a wider column: it widens (down to the slide's
// minimum) and goes back to its width `g.sideW` if the drag returns.
function setNextHeight(px, g) {
  let h = between(px, MIN.next, g.avail - MIN.notes);
  const width = between(h * (aw / ah), g.sideW, g.total - MIN.main);
  sizes.main = 1 - width / g.total;
  h = Math.min(h, width / (aw / ah));
  sizes.next = between(h / g.avail, 0.05, 1);
}

function describeSizes() {
  if (!desktop.matches) return;
  const g = measure();
  if (g.total > 0) colSplit.setAttribute('aria-valuenow', String(Math.round((100 * g.mainW) / g.total)));
  if (g.avail > 0) rowSplit.setAttribute('aria-valuenow', String(Math.round((100 * g.nextH) / g.avail)));
}

function saveSizes() {
  try { localStorage.setItem('slidecast.presenterSizes', JSON.stringify(sizes)); } catch { /* storage blocked */ }
}

function commitSizes() {
  applySizes();
  saveSizes();
  describeSizes();
}

// Drag with the pointer captured, so it keeps working over the slides and
// outside the window. `start` reads the layout once and returns the move
// handler; moves are applied once per frame.
function makeSplitter(bar, name, start, nudge, keys) {
  // No focus on click: the arrow keys must keep moving the slides.
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !desktop.matches) return;
    e.preventDefault();
    const move = start(e);
    let last = null;
    let frame = 0;
    const onMove = (ev) => {
      last = ev;
      frame ||= requestAnimationFrame(() => { frame = 0; move(last); applySizes(); });
    };
    const end = () => {
      cancelAnimationFrame(frame);
      if (last) move(last);
      bar.removeEventListener('pointermove', onMove);
      document.body.classList.remove('p-resizing', `p-resizing-${name}`);
      commitSizes();
    };
    try { bar.setPointerCapture(e.pointerId); } catch { return; }
    document.body.classList.add('p-resizing', `p-resizing-${name}`);
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('lostpointercapture', end, { once: true });
  });
  // When reached with Tab, its arrow keys resize instead of changing the slide.
  bar.addEventListener('keydown', (e) => {
    const dir = { [keys[0]]: -1, [keys[1]]: 1 }[e.key];
    if (!dir || !desktop.matches) return;
    e.preventDefault();
    e.stopPropagation();
    nudge(dir * (e.shiftKey ? 80 : 20), measure());
    commitSizes();
  });
  // Double-click: back to the original layout.
  bar.addEventListener('dblclick', () => {
    Object.assign(sizes, DEFAULT_SIZES);
    commitSizes();
  });
}

makeSplitter(colSplit, 'cols', (e) => {
  const g = measure();
  const grab = e.clientX - (g.left + g.mainW);
  return (ev) => setMainWidth(ev.clientX - grab - g.left, g);
}, (d, g) => setMainWidth(g.mainW + d, g), ['ArrowLeft', 'ArrowRight']);

makeSplitter(rowSplit, 'rows', (e) => {
  const g = measure();
  const grab = e.clientY - (g.top + g.nextH);
  return (ev) => setNextHeight(ev.clientY - grab - g.top, g);
}, (d, g) => setNextHeight(g.nextH + d, g), ['ArrowUp', 'ArrowDown']);

applySizes();
describeSizes();
desktop.addEventListener('change', describeSizes);

// ---- frames ----------------------------------------------------------------

const current = createDeckFrame(currentBox, deck.deckUrl, { mode: 'preview' });
let next = null;

function ensureNextFrame() {
  if (next || !desktop.matches) return;
  next = createDeckFrame(nextBox, deck.deckUrl, { mode: 'preview', query: 'index.html?static' });
  next.onReady(() => renderNext());
}
desktop.addEventListener('change', ensureNextFrame);
ensureNextFrame();

function total() {
  return current.steps.length || live.total;
}

function renderNext() {
  if (!next) return;
  const n = live.index + 1;
  const atEnd = total() > 0 && n >= total();
  endCard.hidden = !atEnd;
  next.element.hidden = atEnd;
  if (!atEnd && next.readyState) next.go(n);
}

current.onReady(({ steps }) => {
  conn.send({ t: 'meta', total: steps.length });
  render();
});

// ---- notes -----------------------------------------------------------------

function renderNotes() {
  const step = current.steps[live.index];
  notesBody.replaceChildren();
  if (!step) return;
  const slide = notes[step.slide] ?? {};
  const stepNote = slide.steps?.[String(step.step)];
  if (!slide.notes && !stepNote) {
    notesBody.append(el('p.muted', {}, t('noNotes')));
    return;
  }
  if (slide.notes) {
    const div = el('div.p-note-slide');
    div.innerHTML = renderMarkdown(slide.notes);
    notesBody.append(div);
  }
  if (stepNote) {
    const div = el('div.p-note-step');
    div.innerHTML = renderMarkdown(stepNote);
    notesBody.append(el('h3.p-note-step-title', {}, t('stepNote', { k: step.step })), div);
  }
}

let fontSize = 20;
try { fontSize = Number(localStorage.getItem('slidecast.notesFont')) || 20; } catch { /* storage blocked */ }
function setFont(px) {
  fontSize = Math.max(12, Math.min(48, px));
  notesBody.style.fontSize = `${fontSize}px`;
  try { localStorage.setItem('slidecast.notesFont', String(fontSize)); } catch { /* storage blocked */ }
}
setFont(fontSize);

let slideFolded = false;
try { slideFolded = localStorage.getItem('slidecast.slideFolded') === '1'; } catch { /* storage blocked */ }
function setSlideFolded(on) {
  slideFolded = on;
  document.body.classList.toggle('p-slide-folded', on);
  slideToggle.setAttribute('aria-expanded', String(!on));
  slideToggle.querySelector('.label').textContent = on ? t('showSlide') : t('hideSlide');
  try { localStorage.setItem('slidecast.slideFolded', on ? '1' : '0'); } catch { /* storage blocked */ }
}
setSlideFolded(slideFolded);

// ---- live state ------------------------------------------------------------

function render() {
  const n = total();
  counter.textContent = n ? `${live.index + 1} / ${n}` : `${live.index + 1}`;
  const step = current.steps[live.index];
  slideId.textContent = step ? (step.step ? `${step.slide} · ${step.step}` : step.slide) : '';
  const at = step ? `?${new URLSearchParams({ slide: step.slide, step: String(step.step ?? '') })}` : '';
  editNotes.href = `/admin/edit/${encodeURIComponent(slug)}${at}`;
  btnBlank.textContent = live.blank ? t('unblank') : t('blank');
  btnBlank.classList.toggle('active', live.blank);
  modeSelect.value = live.viewerNav;
  describeMode();
  btnPrev.disabled = live.index <= 0;
  btnNext.disabled = n > 0 && live.index >= n - 1;
  if (current.readyState && current.index !== live.index) current.go(live.index);
  renderNext();
  renderNotes();
}

// ---- tabs and room -----------------------------------------------------------

let tab = 'notes';
try { tab = localStorage.getItem('slidecast.presenterTab') || 'notes'; } catch { /* storage blocked */ }
let seenHands = 0;
function setTab(name) {
  tab = tabs[name] ? name : 'notes';
  for (const [k, btn] of Object.entries(tabs)) btn.setAttribute('aria-selected', String(k === tab));
  notesBody.hidden = tab !== 'notes';
  fontBox.hidden = tab !== 'notes';
  panels.handsPanel.hidden = tab !== 'hands';
  panels.peoplePanel.hidden = tab !== 'people';
  if (tab === 'hands') seenHands = panels.handCount();
  renderHandsTab();
  try { localStorage.setItem('slidecast.presenterTab', tab); } catch { /* storage blocked */ }
}

// The hands tab shows how many there are, and pulses while new ones are unseen.
function renderHandsTab() {
  const n = panels.handCount();
  if (tab === 'hands' || n < seenHands) seenHands = n;
  handsCount.textContent = String(n);
  handsCount.hidden = n === 0;
  tabs.hands.classList.toggle('p-tab-new', n > seenHands);
}
setTab(tab);

function renderRoom(room) {
  viewers.textContent = t('viewersCount', { n: room.viewers });
  roomClosed.hidden = room.open;
  if (Date.now() >= Math.max(closeArmed, roomErrorUntil)) roomBtn.textContent = room.open ? t('closeRoom') : t('openRoom');
  roomBtn.classList.toggle('danger', room.open);
}

async function toggleRoom() {
  const room = panels.room;
  if (!room) return;
  if (room.open && Date.now() >= closeArmed) {
    closeArmed = Date.now() + 3000;
    roomBtn.textContent = t('confirmClose');
    setTimeout(() => renderRoom(panels.room), 3100);
    return;
  }
  closeArmed = 0;
  roomBtn.disabled = true;
  const res = await api(`/api/admin/rooms/${encodeURIComponent(slug)}`, { method: 'PATCH', body: { open: !room.open } })
    .catch(() => ({ ok: false, status: 0 }));
  roomBtn.disabled = false;
  if (res.ok) return;
  // The button itself says it failed for a moment (session expired, network down).
  roomErrorUntil = Date.now() + 3000;
  roomBtn.textContent = t('error', { code: res.data?.error ?? res.status });
  setTimeout(() => renderRoom(panels.room), 3100);
}

// Another device took the last presenter place: offer to watch instead (D8 of 0003).
function presentersFull() {
  app.replaceChildren(el('section.card.p-full', {},
    el('h1', {}, t('presentersFullTitle')),
    el('p.muted', {}, t('presentersFullText')),
    el('a.button.primary', { href: `/${slug}/view?control=off` }, t('watchAsViewer'))));
}

const conn = connectLive(slug, 'presenter', (msg) => {
  if (msg.t === 'state') {
    Object.assign(live, msg);
    render();
  } else if (msg.t === 'notes') {
    notes = msg.slides ?? {};
    renderNotes();
  } else if (msg.t === 'room') {
    panels.update(msg);
    renderRoom(msg);
    renderHandsTab();
  }
}, (status) => {
  reconnecting.hidden = status !== 'reconnecting';
  if (status === 'denied') location.replace(`/${slug}/login?as=presenter`);
  if (status === 'presenters-full') presentersFull();
});

function act(action) {
  if (action === 'next') conn.send({ t: 'step', delta: 1 });
  else if (action === 'prev') conn.send({ t: 'step', delta: -1 });
  else if (action === 'first') conn.send({ t: 'goto', index: 0 });
  else if (action === 'last') conn.send({ t: 'goto', index: Math.max(0, total() - 1) });
  else if (action === 'blank') conn.send({ t: 'blank', on: !live.blank });
  else if (action === 'fullscreen') toggleFullscreen();
}

window.addEventListener('keydown', (e) => {
  if (isOwnKey(e)) return;
  const action = keyActionFromEvent(e);
  if (!action || action === 'live') return;
  e.preventDefault();
  if (acceptKey(action, e.repeat)) act(action);
});

// Swipe on the notes (phone): left = next, right = previous. One finger only
// and clearly horizontal, so scrolling and pinching never change the slide.
let touch = null;
notesBox.addEventListener('touchstart', (e) => {
  touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
notesBox.addEventListener('touchend', (e) => {
  if (!touch || e.touches.length) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) act(dx < 0 ? 'next' : 'prev');
});
notesBox.addEventListener('touchcancel', () => { touch = null; });

// ---- timer and clock -------------------------------------------------------

let timerStart = null;
let timerElapsed = 0;
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
function elapsed() {
  return timerElapsed + (timerStart ? Date.now() - timerStart : 0);
}
function toggleTimer() {
  if (timerStart) {
    timerElapsed = elapsed();
    timerStart = null;
  } else {
    timerStart = Date.now();
  }
  timerToggle.textContent = timerStart ? t('pause') : t('start');
  tick();
}
function resetTimer() {
  timerElapsed = 0;
  timerStart = timerStart ? Date.now() : null;
  tick();
}
function tick() {
  timerText.textContent = fmt(elapsed());
  clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tick, 500);
tick();
