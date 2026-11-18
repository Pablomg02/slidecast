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

export function createParticipant(app, { slug, askNames, hands, contest = false }) {
  const tokenKey = `slidecast.token.${slug}`;
  let token = load(tokenKey);
  let choice = storedChoice();
  let me = null; // last `you` message
  let send = () => {};
  let room = { askNames, hands, contest };
  // Contest mode (0009): a name is needed and must be free; the dialog stays
  // open until the server takes it (D13, D14).
  const namesOn = () => room.askNames || room.contest;
  let slowUntil = 0;
  let pendingName = false; // chosen before the server answered the join

  // ---- name prompt ------------------------------------------------------------
  const nameInput = el('input', {
    type: 'text', id: 'join-name', maxLength: MAX_NAME, autocomplete: 'nickname', placeholder: t('joinName'),
  });
  const joinHint = el('p.muted', { id: 'join-hint' }, t('joinHint'));
  const joinRules = el('p.join-rules', { id: 'join-rules', hidden: true }, t('joinRules'));
  const joinNotice = el('p.join-notice', { id: 'join-notice', hidden: true });
  const joinError = el('p.join-error', { id: 'join-error', role: 'alert', hidden: true });
  const anonBtn = el('button', { type: 'button', id: 'join-anonymous', onclick: () => choose(null) }, t('joinAnonymous'));
  const joinForm = el('form.join-form', { method: 'dialog' },
    el('h2', {}, t('joinTitle')),
    joinNotice,
    joinHint,
    joinRules,
    el('label.visually-hidden', { htmlFor: 'join-name' }, t('joinName')), nameInput,
    joinError,
    el('div.row.join-actions', {},
      el('button.primary', { type: 'submit', id: 'join-enter' }, t('joinEnter')),
      anonBtn));
  const joinDialog = el('dialog.card.join-dialog', {}, joinForm);
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    choose(nameInput.value.trim() || null);
  });
  // Escape does not dismiss it: a choice is needed (anonymous is one click).
  joinDialog.addEventListener('cancel', (e) => e.preventDefault());

  function choose(name) {
    if (room.contest && name === null) return showJoinError(t('nameNeeded'));
    choice = { name };
    store('slidecast.name', JSON.stringify(choice));
    showJoinError(null);
    // In contest mode the dialog waits for the server to take the name.
    if (!room.contest || (me && me.name === name)) joinDialog.close();
    if (!me) pendingName = true;
    else if (me.name !== name) send({ t: 'name', name });
  }

  function showJoinError(text) {
    joinError.textContent = text ?? '';
    joinError.hidden = !text;
  }

  function askName(notice = null) {
    nameInput.value = choice?.name ?? '';
    anonBtn.hidden = room.contest;
    joinHint.textContent = t(room.contest ? 'joinHintContest' : 'joinHint');
    joinRules.hidden = !room.contest;
    joinNotice.textContent = notice ?? '';
    joinNotice.hidden = !notice;
    if (!joinDialog.open) joinDialog.showModal();
    nameInput.focus();
  }

  // ---- bar: who you are, your hand ----------------------------------------------
  const who = el('button.p-who', { type: 'button', id: 'who', onclick: () => { if (namesOn()) askName(); } },
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
  // Contest mode: own points and place (D25 of 0009).
  const scoreBadge = el('span.p-score', { id: 'score', hidden: true });
  const barRow = el('div.row', {}, who, scoreBadge, handBtn, handStatus);
  const bar = el('div.participant-bar', { hidden: true }, panel, barRow);
  // The row wraps on a narrow phone: whatever sits above the bar ("Back to live")
  // needs its real height.
  new ResizeObserver(() => { app.style.setProperty('--p-bar-h', `${barRow.offsetHeight}px`); }).observe(barRow);

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
    who.disabled = !namesOn();
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
    state({ askNames: a, hands: h, contest: c = false }) {
      const was = room.contest;
      room = { askNames: a, hands: h, contest: c };
      hideNotice();
      bar.hidden = false;
      if (!c) scoreBadge.hidden = true;
      // Contest mode began while this participant had no name.
      if (c && !was && me && me.name === null) askName();
      render();
    },
    // An answer refused for want of a name (contest mode).
    needName() { askName(t('nameNeeded')); },
    onMessage(msg) {
      if (msg.t === 'you') {
        const before = me?.hand ?? null;
        const fresh = msg.token && msg.token !== token;
        if (msg.token) {
          token = msg.token;
          store(tokenKey, token);
        }
        me = msg;
        if (msg.renameAsked) {
          // The presenter wants another name: the old one is not offered again.
          choice = null;
          store('slidecast.name', null);
          askName(t('renameAsked'));
        } else if (namesOn()) {
          // Contest mode: a stored "anonymous" choice is no choice, and a
          // participant left without a name (a reload after a taken name)
          // sends its stored one again or is asked (D13 of 0009).
          const needs = room.contest && me.name === null && !joinDialog.open;
          if (!choice || (room.contest && choice.name === null)) askName();
          else if ((fresh || pendingName || needs) && choice.name !== me.name) send({ t: 'name', name: choice.name });
          else if (room.contest && joinDialog.open && me.name !== null && me.name === choice.name) joinDialog.close();
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
      } else if (msg.t === 'error' && (msg.code === 'name-taken' || msg.code === 'name-needed')) {
        askName();
        showJoinError(t(msg.code === 'name-needed' ? 'nameNeeded' : msg.offline ? 'nameTakenOffline' : 'nameTaken'));
      } else if (msg.t === 'score') {
        scoreBadge.hidden = !msg.on;
        const points = Number(msg.points).toLocaleString();
        scoreBadge.textContent = msg.pos === null ? t('scoreUnranked', { points })
          : t('scoreBar', { points, pos: msg.pos, of: msg.of });
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
