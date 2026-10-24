// What a viewer without presenter rights sees of the room (0003): the name
// prompt, their own label, the raise-hand button and the room's notices.
import { t, el, icon, participantLabel } from './shell.js';

const MAX_NAME = 40;
const MAX_NOTE = 280;

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage blocked: kept for this page only */ }
}

// The name chosen on this browser: {name: string|null}, or null if never asked.
function storedChoice() {
  try {
    const v = JSON.parse(load('slidecast.name'));
    return v && typeof v === 'object' && 'name' in v ? v : null;
  } catch {
    return null;
  }
}

export function createParticipant(app, { slug, askNames, hands }) {
  const tokenKey = `slidecast.token.${slug}`;
  let token = load(tokenKey);
  let choice = storedChoice();
  let me = null; // last `you` message
  let send = () => {};
  let room = { askNames, hands };
  let slowUntil = 0;
  let pendingName = false; // chosen before the server answered the join

  // ---- name prompt ------------------------------------------------------------
  const nameInput = el('input', {
    type: 'text', id: 'join-name', maxLength: MAX_NAME, autocomplete: 'nickname', placeholder: t('joinName'),
  });
  const joinForm = el('form.join-form', { method: 'dialog' },
    el('h2', {}, t('joinTitle')),
    el('p.muted', {}, t('joinHint')),
    el('label.visually-hidden', { htmlFor: 'join-name' }, t('joinName')), nameInput,
    el('div.row.join-actions', {},
      el('button.primary', { type: 'submit', id: 'join-enter' }, t('joinEnter')),
      el('button', { type: 'button', id: 'join-anonymous', onclick: () => choose(null) }, t('joinAnonymous'))));
  const joinDialog = el('dialog.card.join-dialog', {}, joinForm);
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    choose(nameInput.value.trim() || null);
  });
  // Escape does not dismiss it: a choice is needed (anonymous is one click).
  joinDialog.addEventListener('cancel', (e) => e.preventDefault());

  function choose(name) {
    choice = { name };
    store('slidecast.name', JSON.stringify(choice));
    joinDialog.close();
    if (!me) pendingName = true;
    else if (me.name !== name) send({ t: 'name', name });
  }

  function askName() {
    nameInput.value = choice?.name ?? '';
    if (!joinDialog.open) joinDialog.showModal();
    nameInput.focus();
  }

  // ---- bar: who you are, your hand ----------------------------------------------
  const who = el('button.p-who', { type: 'button', id: 'who', onclick: () => { if (room.askNames) askName(); } },
    icon('user'), el('span.label'));
  const handBtn = el('button.hand-btn', { type: 'button', id: 'hand', onclick: () => onHand() },
    icon('hand'), el('span.label', {}, t('raiseHand')));
  const handStatus = el('span.hand-status', { id: 'hand-status', role: 'status' });
  const note = el('textarea', { id: 'hand-note', rows: 3, maxLength: MAX_NOTE, placeholder: t('handNote') });
  const counter = el('span.hand-count.muted', {}, `0/${MAX_NOTE}`);
  note.addEventListener('input', () => { counter.textContent = `${[...note.value].length}/${MAX_NOTE}`; });
  const raiseBtn = el('button.primary', { type: 'submit', id: 'hand-raise' }, t('raiseHand'));
  const panel = el('form.hand-panel.card', { hidden: true },
    el('label.visually-hidden', { htmlFor: 'hand-note' }, t('handNote')), note,
    el('div.row', {}, counter, el('span.grow'),
      el('button', { type: 'button', onclick: () => { panel.hidden = true; } }, t('cancel')), raiseBtn));
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    if (Date.now() < slowUntil) return;
    send({ t: 'hand', up: true, note: note.value });
  });
  const bar = el('div.participant-bar', { hidden: true }, panel, el('div.row', {}, who, handBtn, handStatus));

  const toast = el('div.toast', { hidden: true, role: 'status' });
  let toastTimer = null;
  function showToast(text, kind = '') {
    toast.textContent = text;
    toast.className = `toast ${kind}`;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  // ---- notices over the deck (closed, locked, full, removed) --------------------
  const noticeTitle = el('h2');
  const noticeText = el('p.muted');
  const notice = el('div.room-notice', { hidden: true }, el('div.card', {}, noticeTitle, noticeText));
  function showNotice(kind) {
    const keys = {
      closed: ['roomClosedTitle', 'roomClosedText'],
      locked: ['roomLockedTitle', 'roomLockedText'],
      full: ['roomFullTitle', 'roomFullText'],
      kicked: ['kickedTitle', 'kickedText'],
    }[kind];
    noticeTitle.textContent = t(keys[0]);
    noticeText.textContent = t(keys[1]);
    notice.hidden = false;
    notice.dataset.kind = kind;
    document.body.classList.add('room-waiting');
    bar.hidden = true;
    if (joinDialog.open) joinDialog.close();
  }
  function hideNotice() {
    notice.hidden = true;
    document.body.classList.remove('room-waiting');
  }

  app.append(bar, toast, notice, joinDialog);

  function onHand() {
    if (me?.hand) {
      send({ t: 'hand', up: false });
      return;
    }
    panel.hidden = !panel.hidden;
    if (!panel.hidden) note.focus();
  }

  function render() {
    if (!me) return;
    who.querySelector('.label').textContent = t('youAre', { name: participantLabel(me) });
    who.disabled = !room.askNames;
    const hand = me.hand;
    handBtn.hidden = !room.hands && !hand;
    handBtn.querySelector('.label').textContent = hand ? t('lowerHand') : t('raiseHand');
    handBtn.classList.toggle('active', Boolean(hand));
    bar.classList.toggle('has-hand', Boolean(hand));
    bar.classList.toggle('attending', hand?.state === 'attending');
    handStatus.textContent = !hand ? ''
      : hand.state === 'attending' ? t('handAttending')
        : hand.state === 'queued' ? t('handQueued', { pos: hand.pos })
          : t('handRaised');
    if (hand || !room.hands) panel.hidden = true;
  }

  function slowDown(ms) {
    slowUntil = Date.now() + ms;
    const tick = () => {
      const left = Math.ceil((slowUntil - Date.now()) / 1000);
      raiseBtn.disabled = left > 0;
      raiseBtn.textContent = left > 0 ? t('waitSeconds', { s: left }) : t('raiseHand');
      if (left > 0) setTimeout(tick, 250);
    };
    tick();
  }

  return {
    // The first message of every connection (D5 of 0003).
    hello: () => ({ t: 'join', token }),
    attach(sender) { send = sender; },
    // Room-wide flags from the state message.
    state({ askNames: a, hands: h }) {
      room = { askNames: a, hands: h };
      hideNotice();
      bar.hidden = false;
      render();
    },
    onMessage(msg) {
      if (msg.t === 'you') {
        const before = me?.hand ?? null;
        const fresh = msg.token && msg.token !== token;
        if (msg.token) {
          token = msg.token;
          store(tokenKey, token);
        }
        me = msg;
        if (room.askNames) {
          if (!choice) askName();
          else if ((fresh || pendingName) && choice.name !== me.name) send({ t: 'name', name: choice.name });
        }
        pendingName = false;
        if (me.hand?.state === 'attending' && before?.state !== 'attending') {
          showToast(t('handAttending'), 'toast-accent');
          navigator.vibrate?.([200, 100, 200]);
        }
        if (msg.resolved && before) showToast(t('handResolved'));
        if (me.hand && !before) note.value = '';
        render();
      } else if (msg.t === 'wait') {
        showNotice(msg.reason === 'locked' ? 'locked' : 'closed');
      } else if (msg.t === 'error' && msg.code === 'slow-down' && Number.isFinite(msg.wait)) {
        slowDown(msg.wait);
      }
    },
    // Connection status from connectLive; true if the page should stop here.
    status(status) {
      if (status === 'kicked') showNotice('kicked');
      else if (status === 'full') showNotice('full');
      return status === 'kicked';
    },
    showNotice,
  };
}
