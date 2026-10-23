// Viewer: full-window deck that follows the live step (D15), or drives it when
// this session can present (projector case, D16).
import {
  t, el, api, slugFromPath, setTitle, connectLive, createDeckFrame, keyActionFromEvent,
  toggleFullscreen,
} from './shell.js';

const slug = slugFromPath();
const app = document.getElementById('app');

const info = await api(`/api/decks/${encodeURIComponent(slug)}`);
if (info.status === 403) location.replace(`/${slug}/login?as=viewer`);
if (!info.ok) throw new Error(`deck info: ${info.status}`);
setTitle(info.data.title);

const controlling = info.data.canPresent;
const stage = el('div.viewer-stage');
const blank = el('div.blank-overlay', { hidden: true });
const idleCover = el('div.idle-cover', { hidden: true });
const badges = el('div.badges');
const reconnecting = el('span.badge.badge-warn', { hidden: true }, t('reconnecting'));
const controlBadge = el('span.badge.badge-control', { hidden: !controlling }, t('controlling'));
const liveBtn = el('button.back-to-live', { hidden: true, onclick: () => attach() }, t('backToLive'));
const message = el('div.deck-message', { hidden: true });
badges.append(controlBadge, reconnecting);
app.append(stage, blank, idleCover, liveBtn, badges, message);

const frame = createDeckFrame(stage, info.data.deckUrl, { mode: 'live' });
const live = { index: 0, total: 0, blank: false, viewerNav: info.data.viewerNav, rev: -1 };
let local = 0; // step shown here
let attached = true;
let ready = false;

function total() {
  return frame.steps.length || live.total;
}

function show(index) {
  local = Math.max(0, Math.min(total() - 1, index));
  if (ready && frame.index !== local) frame.go(local);
  liveBtn.hidden = attached || controlling;
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

function localMove(target) {
  target = Math.max(0, Math.min(total() - 1, target));
  if (!allowed(target)) return;
  attached = target === live.index;
  show(target);
}

const conn = connectLive(slug, controlling ? 'presenter' : 'viewer', (msg) => {
  if (msg.t !== 'state') return;
  const navChanged = msg.viewerNav !== live.viewerNav;
  Object.assign(live, msg);
  blank.hidden = !live.blank;
  if (live.viewerNav === 'follow' && navChanged) attached = true;
  if (!attached && live.viewerNav === 'back' && local > live.index) attached = true;
  if (attached || controlling || live.viewerNav === 'follow') {
    attached = true;
    show(live.index);
  } else {
    show(local);
  }
}, (status) => {
  reconnecting.hidden = status === 'open';
  if (status === 'denied') location.reload();
});

frame.onReady(({ steps }) => {
  ready = true;
  if (controlling) conn.send({ t: 'meta', total: steps.length });
  show(attached ? live.index : local);
});

frame.onError((code) => {
  if (code === 'no-deck-api') {
    message.textContent = t('noDeckApi');
    message.hidden = false;
  }
});

// The deck moved by itself (e.g. its own index overlay): accept it only if the
// policy allows it, otherwise put it back.
frame.onChanged((index, own) => {
  if (own || index === local) return;
  if (controlling) {
    conn.send({ t: 'goto', index });
    return;
  }
  if (allowed(index)) {
    attached = index === live.index;
    local = index;
    liveBtn.hidden = attached;
  } else {
    frame.go(local);
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

frame.onInput(onAction);
window.addEventListener('keydown', (e) => {
  const action = keyActionFromEvent(e);
  if (!action) return;
  e.preventDefault();
  if (!e.repeat) onAction(action);
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
