// Viewer: full-window deck that follows the live step (D15), or drives it when
// this session can present (projector case, D16). Without presenter rights the
// viewer is a participant of the room (0003): name, hand, room notices. A poll
// shown by the presenter takes a column beside the slide (0006): participants
// answer it, the projector shows it, with its results once the presenter
// shows them (0008).
import {
  t, el, api, slugFromPath, setTitle, connectLive, createDeckFrame, keyActionFromEvent,
  toggleFullscreen, acceptKey, isOwnKey, icon, parseAspect, parseLayout, layoutGuard,
} from './shell.js';
import { createParticipant } from './participant.js';
import { createViewerPoll } from './viewer-poll.js';
import { createPointerLayer } from './pointer.js';

const slug = slugFromPath();
const app = document.getElementById('app');

const info = await api(`/api/decks/${encodeURIComponent(slug)}`);
if (info.status === 403) location.replace(`/${slug}/login?as=viewer`);
if (!info.ok) throw new Error(`deck info: ${info.status}`);
setTitle(info.data.title);

// A viewer that may present controls the deck unless this tab opted out
// with ?control=off (D1 of 0002); switching reloads the page in the other role.
const params = new URLSearchParams(location.search);
const controlling = info.data.canPresent && params.get('control') !== 'off';
function setControl(on) {
  if (on) params.delete('control');
  else params.set('control', 'off');
  const query = params.toString();
  location.replace(`${location.pathname}${query ? `?${query}` : ''}`);
}
const stage = el('div.viewer-stage');
const blank = el('div.blank-overlay', { hidden: true });
const idleCover = el('div.idle-cover', { hidden: true });
const badges = el('div.badges');
const reconnecting = el('span.badge.badge-warn', { hidden: true }, t('reconnecting'));
const controlBadge = el('span.badge.badge-control', { hidden: !controlling }, t('controlling'));
const liveBtn = el('button.back-to-live', { hidden: true, onclick: () => attach() }, t('backToLive'));
const message = el('div.deck-message', { hidden: true });
const navHint = el('div.nav-hint', { hidden: true, role: 'status' });
const noPresenter = el('div.no-presenter', { hidden: true, role: 'status' },
  el('span', {}, t('noPresenter')),
  el('button', { type: 'button', 'aria-label': t('close'), onclick: () => { dismissed = true; noPresenter.hidden = true; } }, '×'));
const controlToggle = el('button.badge.control-toggle', {
  type: 'button',
  hidden: !info.data.canPresent,
  onclick: () => setControl(!controlling),
}, t(controlling ? 'stopControlling' : 'takeControl'));
badges.append(controlBadge, controlToggle, reconnecting);

// On a touch screen a small button opens two arrows at the bottom, previous and
// next: swipes are turned off here (too easy to miss, or to take for a tap).
// Open or closed is remembered on this device. CSS shows it only on touch screens.
const REMOTE_KEY = 'slidecast.remote';
const remotePrev = el('button.remote-arrow', {
  type: 'button', id: 'remote-prev', 'aria-label': t('prev'), onclick: () => onAction('prev'),
}, icon('prev'));
const remoteNext = el('button.remote-arrow', {
  type: 'button', id: 'remote-next', 'aria-label': t('next'), onclick: () => onAction('next'),
}, icon('next'));
const remoteToggle = el('button.remote-toggle', {
  type: 'button', id: 'remote-toggle', onclick: () => setRemote(!remote.classList.contains('open')),
});
const remote = el('div.remote', { hidden: true }, remotePrev, remoteNext, remoteToggle);
function setRemote(open, save = true) {
  remote.classList.toggle('open', open);
  remotePrev.hidden = !open;
  remoteNext.hidden = !open;
  remoteToggle.replaceChildren(icon(open ? 'close' : 'remote'));
  remoteToggle.setAttribute('aria-expanded', String(open));
  remoteToggle.setAttribute('aria-label', t(open ? 'hideRemote' : 'showRemote'));
  if (!save) return;
  try { localStorage.setItem(REMOTE_KEY, open ? '1' : '0'); } catch { /* storage blocked */ }
}
setRemote((() => { try { return localStorage.getItem(REMOTE_KEY) === '1'; } catch { return false; } })(), false);

app.append(stage, blank, idleCover, liveBtn, badges, message, navHint, noPresenter, remote);
// The slide's shape, so a phone held upright puts the poll under it.
const [aw, ah] = parseAspect(info.data.aspect);
app.style.setProperty('--ar', String(aw / ah));

const poll = createViewerPoll(app, { display: info.data.canPresent, badges });

// The contest's top 10 on the projector, when the presenter shows it (D27 of 0009).
const rankingList = el('ol.ranking-list', { id: 'ranking-list' });
const rankingSub = el('span.ranking-sub');
const ranking = el('div.ranking-overlay', { id: 'ranking', hidden: true },
  el('div.ranking-card', {}, el('h2.ranking-title', {}, t('rankingTitle'), ' ', rankingSub), rankingList));
app.append(ranking);
let rankingMsg = null;
const cut = (s, n) => ([...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s);
function renderRanking() {
  const m = rankingMsg;
  ranking.hidden = !m?.shown || live.blank;
  if (!ranking.hidden) dots?.clear();
  if (ranking.hidden) return;
  // A projector tab that controls the slides gets the presenters' full list.
  const rows = m.rows.slice(0, 10);
  const total = m.total ?? m.rows.length;
  rankingSub.textContent = `· ${t('rankingTop', { n: rows.length, total })}`;
  rankingList.replaceChildren(...rows.map((r) => el(`li.ranking-row${r.pos <= 3 ? `.ranking-top.ranking-pos-${r.pos}` : ''}`, {},
    el('span.ranking-pos', {}, String(r.pos)),
    el('span.ranking-name', {}, cut(r.name ?? `#${r.n}`, 20)),
    el('span.ranking-points', {}, t('rankingPts', { points: Number(r.points).toLocaleString() })))));
}
const participant = info.data.canPresent ? null : createParticipant(app, info.data);
// A closed room gives its audience no deck: wait for it to open (D4 of 0003).
const layout = parseLayout(info.data.layout); // frozen deck (0010)
const frame = info.data.deckUrl
  ? createDeckFrame(stage, info.data.deckUrl, { mode: 'live', swipe: false, virtual: layout })
  : null;
if (!frame) participant.showNotice('closed');
// The presenters' laser dots (0010), only over a frozen deck.
const dots = layout && frame?.layer ? createPointerLayer(frame.layer) : null;
const live = { index: 0, total: 0, blank: false, viewerNav: info.data.viewerNav, rev: -1 };
let local = 0; // step shown here
let attached = true;
let ready = false;

function total() {
  return frame?.steps.length || live.total;
}

function show(index) {
  local = Math.max(0, Math.min(total() - 1, index));
  if (local !== live.index) dots?.clear(); // they point at the live step's content (D26 of 0010)
  if (ready && frame.index !== local) frame.go(local);
  liveBtn.hidden = attached || controlling;
  updateRemote();
}

// No arrows when the viewer may not move; each one off where it cannot go.
function updateRemote() {
  remote.hidden = !frame || stage.hidden || (!controlling && live.viewerNav === 'follow');
  const at = controlling ? live.index : local;
  const can = (i) => ready && i >= 0 && i < total() && (controlling || allowed(i));
  remotePrev.disabled = !can(at - 1);
  remoteNext.disabled = !can(at + 1);
}

function attach() {
  attached = true;
  show(live.index);
}

// May this viewer show `index` by itself?
function allowed(index) {
  if (controlling) return false;
  if (live.viewerNav === 'follow') return false;
  if (live.viewerNav === 'back') return index <= live.index;
  return true;
}

// Says briefly why a move did nothing: the mode set by the presenter forbids it.
let navHintTimer = null;
function refuse() {
  navHint.textContent = t(live.viewerNav === 'follow' ? 'navLocked' : 'navNoAhead');
  navHint.hidden = false;
  clearTimeout(navHintTimer);
  navHintTimer = setTimeout(() => { navHint.hidden = true; }, 2500);
}

// Nobody with presenter rights is connected. A few seconds' wait keeps a
// presenter's reload from flashing it; closed by hand, it stays closed until
// a presenter comes and goes again.
let dismissed = false;
let noPresenterTimer = null;
function presence(presenting) {
  if (presenting) {
    clearTimeout(noPresenterTimer);
    noPresenterTimer = null;
    dismissed = false;
    noPresenter.hidden = true;
  } else if (!dismissed && noPresenter.hidden && !noPresenterTimer) {
    noPresenterTimer = setTimeout(() => { noPresenterTimer = null; noPresenter.hidden = false; }, 3000);
  }
}

function localMove(target) {
  target = Math.max(0, Math.min(total() - 1, target));
  if (target === local) return; // first or last step: nothing to refuse
  if (!allowed(target)) {
    refuse();
    return;
  }
  attached = target === live.index;
  show(target);
}

const layoutOk = layoutGuard(slug, info.data.layout);
const conn = connectLive(slug, controlling ? 'presenter' : 'viewer', (msg) => {
  // The deck is drawn another way now (frozen, 0010): reload to follow it.
  if (msg.t === 'state' && !layoutOk(msg.layout)) return;
  if (msg.t === 'ptr') {
    if (!dots) return;
    if (msg.clear) dots.clear();
    else if (msg.off) dots.hide(msg.id);
    else if (local === live.index && !live.blank && ranking.hidden) dots.show(msg.id, msg.id, msg.x, msg.y);
    return;
  }
  // Loaded while the room was closed, then admitted without the "again" signal
  // (its socket dropped while waiting): reload to get the deck.
  if (!frame) {
    if (msg.t === 'state' || msg.t === 'you') location.reload();
    else participant.onMessage(msg);
    return;
  }
  if (msg.t === 'poll' || msg.t === 'polls' || msg.t === 'poll-counts') {
    poll.onMessage(msg);
    return;
  }
  if (msg.t === 'error' && msg.about === 'poll') {
    poll.onError(msg);
    if (msg.code === 'name-needed') participant?.needName();
    return;
  }
  if (msg.t === 'ranking') {
    rankingMsg = msg;
    renderRanking();
    return;
  }
  if (msg.t !== 'state') {
    if (msg.t === 'wait') poll.clear(); // the room closed: everything is forgotten
    participant?.onMessage(msg);
    return;
  }
  participant?.state(msg);
  if (msg.index !== live.index || (msg.blank && !live.blank)) dots?.clear();
  const navChanged = msg.viewerNav !== live.viewerNav;
  Object.assign(live, msg);
  document.body.dataset.nav = live.viewerNav; // lets the tests wait for a mode change
  blank.hidden = !live.blank;
  poll.setBlank(live.blank);
  renderRanking();
  presence(live.presenting);
  if (live.viewerNav === 'follow' && navChanged) attached = true;
  if (!attached && live.viewerNav === 'back' && local > live.index) attached = true;
  if (attached || controlling || live.viewerNav === 'follow') {
    attached = true;
    show(live.index);
  } else {
    show(local);
  }
}, (status) => {
  reconnecting.hidden = status !== 'reconnecting';
  poll.connection(status);
  if (participant?.status(status)) {
    stage.hidden = true;
    updateRemote();
    poll.clear();
    return;
  }
  // No presenter place left for this device: keep showing the deck, without control.
  if (status === 'presenters-full') setControl(false);
  else if (status === 'denied' || status === 'again') location.reload();
}, { hello: participant?.hello });
participant?.attach((msg) => conn.send(msg));
poll.attach((msg) => conn.send(msg));

frame?.onReady(({ steps }) => {
  ready = true;
  if (controlling) conn.send({ t: 'meta', total: steps.length });
  show(attached ? live.index : local);
});

frame?.onError((code) => {
  if (code === 'no-deck-api') {
    message.textContent = t('noDeckApi');
    message.hidden = false;
  }
});

// The deck moved by itself (e.g. its own index overlay): accept it only if the
// policy allows it, otherwise put it back.
frame?.onChanged((index, own) => {
  if (own || index === local) return;
  if (controlling) {
    conn.send({ t: 'goto', index });
    return;
  }
  if (allowed(index)) {
    attached = index === live.index;
    local = index;
    if (!attached) dots?.clear(); // the deck moved itself off the live step (D26 of 0010)
    liveBtn.hidden = attached;
    updateRemote();
  } else {
    frame.go(local);
    refuse();
  }
});

function onAction(action) {
  if (action === 'fullscreen') return toggleFullscreen();
  if (controlling) {
    if (action === 'next') conn.send({ t: 'step', delta: 1 });
    else if (action === 'prev') conn.send({ t: 'step', delta: -1 });
    else if (action === 'first') conn.send({ t: 'goto', index: 0 });
    else if (action === 'last') conn.send({ t: 'goto', index: Math.max(0, total() - 1) });
    else if (action === 'blank') conn.send({ t: 'blank', on: !live.blank });
    return undefined;
  }
  if (action === 'live') return attach();
  if (action === 'next') localMove(local + 1);
  else if (action === 'prev') localMove(local - 1);
  else if (action === 'first') localMove(0);
  else if (action === 'last') localMove(live.viewerNav === 'free' ? total() - 1 : live.index);
  return undefined;
}

frame?.onInput(onAction);
// A frozen deck leaves black bars: a click there counts as a click on the slide.
if (frame && layout) stage.addEventListener('click', (e) => { if (e.target === stage) onAction('next'); });
window.addEventListener('keydown', (e) => {
  if (isOwnKey(e)) return; // Enter or Space on a button: the button's own
  const action = keyActionFromEvent(e);
  if (!action) return;
  e.preventDefault();
  if (acceptKey(action, e.repeat)) onAction(action);
});

// Hide the cursor after 2.5 s without movement. Mouse moves over the iframe
// do not reach this page, so an invisible cover takes the pointer while idle.
let idleTimer = null;
function wake() {
  idleCover.hidden = true;
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleCover.hidden = false;
    document.body.classList.add('idle');
  }, 2500);
}
idleCover.addEventListener('mousemove', wake);
idleCover.addEventListener('click', () => {
  wake();
  onAction('next');
});
window.addEventListener('mousemove', wake);
wake();
