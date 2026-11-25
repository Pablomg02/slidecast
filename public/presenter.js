// Presenter view: current step, next step, notes, timer and controls.
// Desktop (≥ 900 px) shows the next-step preview, with dividers to resize the
// three boxes; the phone layout does not create it at all and shows large
// prev/next buttons instead.
import {
  t, el, api, slugFromPath, setTitle, connectLive, createDeckFrame, keyActionFromEvent,
  toggleFullscreen, isOwnKey, icon, acceptKey, parseAspect, parseLayout, layoutGuard,
} from './shell.js';
import { renderMarkdown } from './markdown.js';
import { createRoomPanels } from './presenter-room.js';
import { createPresenterPoll } from './presenter-poll.js';
import { createPresenterRanking } from './presenter-ranking.js';
import { PTR_COLORS, createPointerLayer, createPointerSender } from './pointer.js';

const slug = slugFromPath();
const app = document.getElementById('app');
const info = await api(`/api/decks/${encodeURIComponent(slug)}`);
if (!info.ok || !info.data.canPresent) location.replace(`/${slug}/login?as=presenter`);
const deck = info.data;
setTitle(deck.title);

const [aw, ah] = parseAspect(deck.aspect);
const desktop = window.matchMedia('(min-width: 900px)');
const live = { index: 0, total: 0, blank: false, viewerNav: deck.viewerNav, contest: deck.contest };
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
// Jump to the first and last step (Home and End do the same). On a phone they
// appear beside prev/next only with "more" open, away from the thumb.
const btnFirst = el('button.p-jump', { id: 'first', title: t('first'), 'aria-label': t('first'), onclick: () => act('first') }, icon('first'));
const btnLast = el('button.p-jump', { id: 'last', title: t('last'), 'aria-label': t('last'), onclick: () => act('last') }, icon('last'));
// The shared laser pointer (0010): only on frozen decks with the pointer on.
const laserBtn = el('button.p-laser', {
  type: 'button', id: 'laser', title: t('laserPointer'), 'aria-label': t('laserPointer'), 'aria-pressed': 'false', hidden: true,
  onclick: () => setLaser(!laserOn),
}, icon('laser'));
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
// B blanks the screens; with no button for it, a badge says they are blank:
// above the notes on a computer, as a row of the toolbar on a phone, where
// the tabs leave no room for it.
const blanked = el('span.badge.badge-warn.p-blanked', { id: 'blanked', hidden: true }, t('blankedBadge'));
const blankedBar = el('span.badge.badge-warn.p-blanked', { id: 'blanked-bar', hidden: true }, t('blankedBadge'));
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
// The join screen on the screens (0011): QR code, address and maybe the
// password. A strip above the notes says it is on, why something is
// missing, and takes it off.
let share = null; // the last {t: 'share'} message
const shareBtn = el('button.p-share', {
  type: 'button', id: 'share-toggle', title: `${t('shareShow')}: ${t('shareShowHint')}`, 'aria-label': t('shareShow'), 'aria-pressed': 'false',
  onclick: () => conn.send({ t: 'share', on: !share?.shown }),
}, icon('qr'), el('span.p-share-label', {}, t('shareShow'))); // the label only on a phone
const shareNote = el('span.p-share-note.muted', { id: 'share-note' });
const shareStrip = el('div.p-share-strip', { id: 'share-strip', hidden: true },
  el('div.p-share-text', {}, el('strong', {}, icon('qr'), t('shareOnScreens')), shareNote),
  el('button.small.p-poll-off', { type: 'button', id: 'share-off', onclick: () => conn.send({ t: 'share', on: false }) }, t('shareTakeOff')));
function renderShare() {
  const on = Boolean(share?.shown);
  shareStrip.hidden = !on;
  shareBtn.setAttribute('aria-pressed', String(on));
  shareBtn.classList.toggle('p-share-on', on);
  const room = panels.room;
  const notes = [
    share?.passwordMissing && t('sharePasswordMissing'),
    room && !room.open && t('shareRoomClosed'),
    room?.locked && t('shareLocked'),
  ].filter(Boolean);
  shareNote.textContent = notes.join(' ');
  shareNote.hidden = !notes.length;
}
const openViewer = el('a.button', { href: `/${slug}/view`, target: '_blank', rel: 'noopener' }, t('openViewer'));
// Admins only: the notes editor, opened at the step being presented (render() keeps the link current).
const editNotes = el('a.button', { id: 'edit-notes', href: `/admin/edit/${encodeURIComponent(slug)}`, hidden: !deck.canAdmin, target: '_blank', rel: 'noopener' }, t('edit'));

// Phone only: fold the current slide away to give the notes more room.
const slideToggle = el('button.p-slide-toggle', { id: 'slide-toggle', onclick: () => setSlideFolded(!slideFolded) },
  icon('chevron'), el('span.label'));

// Notes, the poll, raised hands and people share the side panel, as tabs.
// The Poll tab exists only on a computer while there is a poll to show; on a
// phone "See" opens the same panel in a pop-up (D9 of 0006).
const panels = createRoomPanels({ send: (msg) => conn.send(msg) });
const poll = createPresenterPoll({
  send: (msg) => conn.send(msg),
  onSee: () => (desktop.matches ? setTab('poll') : openPollDialog()),
  onLaunch: () => { if (desktop.matches) setTab('poll'); },
  // Contest mode (0009): the deck's settings, on or off as the room says now.
  contestConfig: () => (!live.contest ? null : { ...deck.contestConfig, ...ranking?.config, on: true }),
});
const ranking = createPresenterRanking({
  send: (msg) => conn.send(msg),
  slug,
  onReveal: (id) => conn.send({ t: 'poll', action: 'reveal', slide: id }),
});
poll.setNotes(notes);
const handsCount = el('span.p-tab-count', { hidden: true });
const pollCount = el('span.p-tab-count', { hidden: true });
const tabs = {
  notes: el('button.p-tab', { type: 'button', role: 'tab', id: 'tab-notes', onclick: () => setTab('notes') }, t('notes')),
  poll: el('button.p-tab', { type: 'button', role: 'tab', id: 'tab-poll', hidden: true, onclick: () => setTab('poll') }, t('poll'), pollCount),
  hands: el('button.p-tab', { type: 'button', role: 'tab', id: 'tab-hands', onclick: () => setTab('hands') }, t('tabHands'), handsCount),
  people: el('button.p-tab', { type: 'button', role: 'tab', id: 'tab-people', onclick: () => setTab('people') }, t('tabPeople')),
  // Contest mode only, on a computer; a phone opens it from "More" (D26 of 0009).
  ranking: el('button.p-tab', { type: 'button', role: 'tab', id: 'tab-ranking', hidden: true, onclick: () => setTab('ranking') }, t('tabRanking')),
};
const fontBox = el('div.p-font', {}, fontSteps, fontToggle);

// The slide id lives above the notes, not in the toolbar, so its changing
// width never shifts the toolbar.
const notesHead = el('div.p-notes-head', {}, el('div.p-tabs', { role: 'tablist' }, Object.values(tabs)), blanked, roomClosed, slideId, slideToggle);
// The join screen's button: beside the tabs on a computer, where the toolbar
// has no room left; behind "More" on a phone.
const shareGroup = el('div.p-group.p-secondary.p-share-group');
function placeShare() {
  if (desktop.matches) notesHead.insertBefore(shareBtn, slideToggle);
  else shareGroup.append(shareBtn);
  shareGroup.hidden = desktop.matches;
}
placeShare();
desktop.addEventListener('change', placeShare);
const notesBox = el('section.p-notes', {},
  notesHead,
  shareStrip,
  poll.strip,
  notesBody,
  poll.panel,
  panels.handsPanel,
  panels.peoplePanel,
  ranking.panel,
  fontBox);

// Phone only, in contest mode: the ranking in a pop-up, from "More".
const rankingOpen = el('button', { type: 'button', id: 'ranking-open', onclick: () => openRankingDialog() }, t('tabRanking'));
const rankingGroup = el('div.p-group.p-secondary.p-ranking-group', { hidden: true }, rankingOpen);

// Phone only: clock, viewer settings, the room button and first/last stay
// folded behind this button.
const moreToggle = el('button.p-more-toggle', {
  id: 'more', title: t('more'), 'aria-expanded': 'false',
  onclick: () => {
    const open = toolbar.classList.toggle('p-more-open');
    moreToggle.setAttribute('aria-expanded', String(open));
  },
}, icon('more', 'icon icon-fill'));

const toolbar = el('div.p-toolbar', {},
  el('div.p-group.p-nav', {}, btnFirst, btnPrev, counter, btnNext, btnLast, laserBtn),
  el('div.p-group.p-timer', {}, timerText, timerToggle, timerReset, moreToggle),
  el('div.p-group.p-secondary', {}, clock),
  el('div.p-group.p-secondary', {}, modeSelect, viewers),
  shareGroup,
  el('div.p-group.p-secondary', { hidden: !deck.canAdmin }, roomBtn),
  el('div.p-group.p-extra', {}, openViewer, editNotes),
  rankingGroup,
  blankedBar,
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

const layout = parseLayout(deck.layout); // frozen deck (0010)
const current = createDeckFrame(currentBox, deck.deckUrl, { mode: 'preview', virtual: layout });
let next = null;

function ensureNextFrame() {
  if (next || !desktop.matches) return;
  next = createDeckFrame(nextBox, deck.deckUrl, { mode: 'preview', query: 'index.html?static', virtual: layout });
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
  (next.box ?? next.element).hidden = atEnd;
  if (!atEnd && next.readyState) next.go(n);
}

// ---- shared pointer (0010) -------------------------------------------------

// The other presenters' dots, and this page's own one under the key 'self'.
const dots = current.layer ? createPointerLayer(current.layer) : null;
const sender = createPointerSender((msg) => conn.send(msg));
let laserOn = false;
let myPtr = null; // this device's colour slot, from the room message

const laserAllowed = () => Boolean(dots && live.pointer);
function renderLaser() {
  laserBtn.hidden = !laserAllowed();
  laserBtn.setAttribute('aria-pressed', String(laserOn));
  if (myPtr !== null) laserBtn.style.setProperty('--laser', PTR_COLORS[myPtr % PTR_COLORS.length]);
  currentBox.classList.toggle('p-laser-on', laserOn);
}
function hideOwnDot() {
  sender.off();
  dots?.hide('self');
}
function setLaser(on) {
  const next = on && laserAllowed();
  if (next !== laserOn) {
    laserOn = next;
    if (laserOn) conn.send({ t: 'ptr', on: true });
    else hideOwnDot();
  }
  renderLaser();
}
// Mouse only: the current slide never takes the pointer (preview mode), so
// its moves reach this box. Positions are fractions of the drawn deck.
currentBox.addEventListener('pointermove', (e) => {
  if (!laserOn || e.pointerType !== 'mouse' || live.blank) return;
  const r = current.element.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) {
    hideOwnDot();
    return;
  }
  const x = Math.round(fx * 10_000);
  const y = Math.round(fy * 10_000);
  dots.show('self', myPtr ?? 0, x, y);
  sender.move(x, y);
});
currentBox.addEventListener('pointerleave', hideOwnDot);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hideOwnDot(); });

function onPointer(msg) {
  if (!dots) return;
  if (msg.clear) dots.clear();
  else if (msg.off) dots.hide(msg.id);
  else if (!live.blank) dots.show(msg.id, msg.id, msg.x, msg.y);
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
  blanked.hidden = blankedBar.hidden = !live.blank;
  modeSelect.value = live.viewerNav;
  describeMode();
  btnPrev.disabled = btnFirst.disabled = live.index <= 0;
  btnNext.disabled = btnLast.disabled = n > 0 && live.index >= n - 1;
  if (current.readyState && current.index !== live.index) current.go(live.index);
  renderNext();
  renderNotes();
  poll.setSlide(step?.slide ?? null);
  renderPollTab();
}

// ---- tabs and room -----------------------------------------------------------

let tab = 'notes';
try { tab = localStorage.getItem('slidecast.presenterTab') || 'notes'; } catch { /* storage blocked */ }
let seenHands = 0;
// The Poll tab comes and goes with the poll, so it is never remembered.
const pollTabShown = () => desktop.matches && poll.available();
const rankingTabShown = () => desktop.matches && Boolean(live.contest);
function setTab(name) {
  tab = tabs[name] && (name !== 'poll' || pollTabShown()) && (name !== 'ranking' || rankingTabShown()) ? name : 'notes';
  for (const [k, btn] of Object.entries(tabs)) btn.setAttribute('aria-selected', String(k === tab));
  notesBody.hidden = tab !== 'notes';
  fontBox.hidden = tab !== 'notes';
  if (!pollDialog.open) poll.panel.hidden = tab !== 'poll';
  notesBox.classList.toggle('p-tab-poll-on', tab === 'poll');
  panels.handsPanel.hidden = tab !== 'hands';
  panels.peoplePanel.hidden = tab !== 'people';
  if (!rankingDialog.open) ranking.panel.hidden = tab !== 'ranking';
  if (tab === 'hands') seenHands = panels.handCount();
  renderHandsTab();
  if (tab !== 'poll') {
    try { localStorage.setItem('slidecast.presenterTab', tab); } catch { /* storage blocked */ }
  }
}

// The tab shows how many answered the poll on the screens.
function renderPollTab() {
  tabs.poll.hidden = !pollTabShown();
  const n = poll.count();
  pollCount.textContent = String(n ?? 0);
  pollCount.hidden = n === null;
  tabs.poll.classList.toggle('p-tab-live', n !== null);
  if (tab === 'poll' && tabs.poll.hidden) setTab('notes');
}

// Phone: the poll panel in a pop-up, moved back to its tab when it closes.
const pollDialogBody = el('div.p-poll-dialog-body');
const pollDialog = el('dialog.card.p-poll-dialog', { id: 'poll-dialog', 'aria-labelledby': 'poll-dialog-title' },
  el('div.p-poll-dialog-head', {},
    el('h2', { id: 'poll-dialog-title' }, icon('poll'), t('poll')),
    el('button.small', { type: 'button', id: 'poll-dialog-close', onclick: () => pollDialog.close() }, t('close'))),
  pollDialogBody);
pollDialog.addEventListener('close', () => {
  notesBox.insertBefore(poll.panel, panels.handsPanel);
  setTab(tab);
});
document.body.append(pollDialog);
// Phone: the ranking in a pop-up too, moved back to its tab when it closes.
const rankingDialogBody = el('div.p-poll-dialog-body');
const rankingDialog = el('dialog.card.p-poll-dialog', { id: 'ranking-dialog', 'aria-labelledby': 'ranking-dialog-title' },
  el('div.p-poll-dialog-head', {},
    el('h2', { id: 'ranking-dialog-title' }, t('tabRanking')),
    el('button.small', { type: 'button', id: 'ranking-dialog-close', onclick: () => rankingDialog.close() }, t('close'))),
  rankingDialogBody);
rankingDialog.addEventListener('close', () => {
  notesBox.insertBefore(ranking.panel, fontBox);
  setTab(tab);
});
document.body.append(rankingDialog);
function openRankingDialog() {
  rankingDialogBody.append(ranking.panel);
  ranking.panel.hidden = false;
  if (!rankingDialog.open) rankingDialog.showModal();
}
// The Ranking tab and the phone's button come and go with contest mode.
function renderRankingTab() {
  tabs.ranking.hidden = !rankingTabShown();
  rankingGroup.hidden = !live.contest;
  if (tab === 'ranking' && tabs.ranking.hidden) setTab('notes');
  if (!live.contest && rankingDialog.open) rankingDialog.close();
}

function openPollDialog() {
  pollDialogBody.append(poll.panel);
  poll.panel.hidden = false;
  if (!pollDialog.open) pollDialog.showModal();
}
desktop.addEventListener('change', () => {
  if (desktop.matches && pollDialog.open) pollDialog.close();
  if (desktop.matches && rankingDialog.open) rankingDialog.close();
  renderPollTab();
  renderRankingTab();
  setTab(tab);
});

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
  const mine = room.presenters?.find((d) => d.you)?.ptr;
  if (Number.isInteger(mine) && mine !== myPtr) {
    myPtr = mine;
    renderLaser();
  }
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

const layoutOk = layoutGuard(slug, deck.layout);
const conn = connectLive(slug, 'presenter', (msg) => {
  // The deck is drawn another way now (frozen, 0010): reload to follow it.
  if (msg.t === 'state' && !layoutOk(msg.layout)) return;
  if (msg.t === 'ptr') {
    onPointer(msg);
  } else if (msg.t === 'state') {
    // Dots point at one step's content: a new step or a blank screen hides them.
    if (msg.index !== live.index || (msg.blank && !live.blank)) {
      dots?.clear();
      sender.off();
    }
    Object.assign(live, msg);
    if (laserOn && !live.pointer) setLaser(false);
    renderLaser();
    render();
    renderRankingTab();
  } else if (msg.t === 'notes') {
    notes = msg.slides ?? {};
    renderNotes();
    poll.setNotes(notes);
    renderPollTab();
  } else if (msg.t === 'room') {
    panels.update(msg);
    renderRoom(msg);
    renderShare();
    renderHandsTab();
    poll.setViewers(msg.viewers);
  } else if (msg.t === 'polls') {
    poll.update(msg);
    ranking.setRuns(msg.runs ?? []);
    renderPollTab();
  } else if (msg.t === 'ranking') {
    ranking.update(msg);
    poll.setRanking(msg);
  } else if (msg.t === 'share') {
    share = msg;
    renderShare();
  } else if (msg.t === 'error' && (msg.code === 'no-poll' || msg.code === 'time-up' || msg.code === 'contest-off')) {
    poll.onError(msg.code);
  } else if (msg.t === 'error' && msg.code === 'pointer-off') {
    setLaser(false);
  }
}, (status) => {
  reconnecting.hidden = status !== 'reconnecting';
  if (status === 'denied') location.replace(`/${slug}/login?as=presenter`);
  if (status === 'presenters-full') presentersFull();
  if (status === 'again') location.reload(); // e.g. the deck's layout changed (0010)
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
  // P turns the laser on and off (0010), outside text fields.
  if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey && !laserBtn.hidden
    && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
    e.preventDefault();
    if (!e.repeat) setLaser(!laserOn);
    return;
  }
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

// Kept across a reload of this tab (D28 of 0010): a layout change reloads the
// page in the middle of a talk. Opening the page anew starts from zero.
const TIMER_KEY = `sd-timer:${slug}`;
let timerStart = null;
let timerElapsed = 0;
try {
  if (performance.getEntriesByType('navigation')[0]?.type === 'reload') {
    const saved = JSON.parse(sessionStorage.getItem(TIMER_KEY) ?? 'null');
    if (Number.isFinite(saved?.elapsed) && saved.elapsed >= 0) timerElapsed = saved.elapsed;
    if (Number.isFinite(saved?.start) && saved.start <= Date.now()) timerStart = saved.start;
  } else {
    sessionStorage.removeItem(TIMER_KEY); // an earlier talk's timer never comes back
  }
} catch { /* nothing saved, or no storage */ }
function saveTimer() {
  try {
    sessionStorage.setItem(TIMER_KEY, JSON.stringify({ start: timerStart, elapsed: timerElapsed }));
  } catch { /* private mode: the timer still works, it is just not kept */ }
}
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
  saveTimer();
  tick();
}
function resetTimer() {
  timerElapsed = 0;
  timerStart = timerStart ? Date.now() : null;
  saveTimer();
  tick();
}
timerToggle.textContent = timerStart ? t('pause') : t('start');
function tick() {
  timerText.textContent = fmt(elapsed());
  clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tick, 500);
tick();
