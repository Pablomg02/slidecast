// The presenter's view of the room (0003): raised hands and the people in it.
// Every presenter sees the same lists; their actions go to the server, which
// sends the new lists to all of them.
import { t, el, icon, participantLabel, participantNumber } from './shell.js';

const STATE_ORDER = { attending: 0, queued: 1, raised: 2 };

function ago(ms) {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? t('agoNow') : t('agoMin', { m });
}

// A button that asks once more before acting ("Remove?"), for 3 seconds.
// `armed` survives the list being redrawn while it waits.
function confirmButton(label, confirmLabel, key, onConfirm, armed) {
  const btn = el('button.small.danger', { type: 'button' }, label);
  if (armed.key === key && armed.until > Date.now()) btn.textContent = confirmLabel;
  btn.addEventListener('click', () => {
    if (armed.key === key && armed.until > Date.now()) {
      armed.key = null;
      onConfirm();
      return;
    }
    armed.key = key;
    armed.until = Date.now() + 3000;
    btn.textContent = confirmLabel;
    setTimeout(() => { if (armed.key === key && armed.until <= Date.now()) btn.textContent = label; }, 3100);
  });
  return btn;
}

export function createRoomPanels({ send }) {
  let room = null;
  let receivedAt = 0;
  const armed = { key: null, until: 0 };

  // ---- hands ------------------------------------------------------------------
  const handsToggle = el('input', {
    type: 'checkbox', id: 'hands-on', onchange: () => send({ t: 'hands', on: handsToggle.checked }),
  });
  const lowerAll = el('button.small', { type: 'button', id: 'lower-all', onclick: () => send({ t: 'hands-clear' }) }, t('lowerAll'));
  const handsList = el('ol.hand-list', { id: 'hand-list' });
  const handsPanel = el('div.p-panel.p-hands', { hidden: true },
    el('div.p-panel-head', {}, el('label.inline', { htmlFor: 'hands-on' }, handsToggle, ` ${t('handsAllowed')}`), lowerAll),
    handsList);

  function handActions(p) {
    const act = (action, label, cls = '') => el(`button.small${cls}`, {
      type: 'button', onclick: () => send({ t: 'hand', id: p.id, action }),
    }, label);
    const out = [];
    if (p.hand.state === 'raised') out.push(act('queue', t('toQueue')));
    if (p.hand.state !== 'attending') out.push(act('attend', t('attend')));
    out.push(act('resolve', t('resolve'), '.primary'));
    return out;
  }

  function renderHands() {
    const elapsed = Date.now() - receivedAt;
    const hands = room.people.filter((p) => p.hand)
      .sort((a, b) => STATE_ORDER[a.hand.state] - STATE_ORDER[b.hand.state] || a.hand.seq - b.hand.seq);
    handsToggle.checked = room.hands;
    lowerAll.disabled = !hands.length;
    handsList.replaceChildren(...hands.map((p) => el(`li.hand.hand-${p.hand.state}`, { dataset: { id: p.id } },
      el('div.hand-head', {},
        el('span.hand-state', {}, t({ attending: 'stateAttending', queued: 'stateQueued', raised: 'stateRaised' }[p.hand.state])),
        el('strong.hand-who', {}, participantLabel(p)),
        p.name ? el('span.muted', {}, `#${participantNumber(p.n)}`) : null,
        el('span.hand-ago.muted', {}, ago(p.hand.ago + elapsed))),
      p.hand.note ? el('p.hand-note', {}, p.hand.note) : null,
      el('div.hand-actions', {}, handActions(p)))));
    if (!hands.length) handsList.append(el('li.p-empty.muted', {}, t('noHands')));
  }

  // ---- people -------------------------------------------------------------------
  const search = el('input', { type: 'text', id: 'people-search', placeholder: t('searchPeople'), oninput: () => renderPeople() });
  const lock = el('input', { type: 'checkbox', id: 'room-lock', onchange: () => send({ t: 'lock', on: lock.checked }) });
  const peopleCount = el('span.muted', { id: 'people-count' });
  const peopleList = el('ul.people-list', { id: 'people-list' });
  const presentersList = el('ul.people-list.presenters-list', { id: 'presenters-list' });
  const peoplePanel = el('div.p-panel.p-people', { hidden: true },
    el('div.p-panel-head', {}, search, el('label.inline', { htmlFor: 'room-lock' }, lock, ` ${t('lockRoom')}`)),
    peopleCount,
    peopleList,
    el('h3.p-panel-sub', {}, t('presentersHeading')),
    presentersList);

  function renderPeople() {
    lock.checked = room.locked;
    peopleCount.textContent = t('peopleOnline', { n: room.viewers });
    const q = search.value.trim().toLowerCase();
    const people = room.people
      .filter((p) => !q || participantLabel(p).toLowerCase().includes(q) || participantNumber(p.n).includes(q))
      .sort((a, b) => a.n - b.n);
    peopleList.replaceChildren(...people.map((p) => {
      const kick = () => send({ t: 'kick', id: p.id });
      return el(`li.person${p.online ? '' : '.offline'}`, { dataset: { id: p.id } },
        el('span.dot', { title: p.online ? '' : t('offline') }),
        el('span.person-name', {}, participantLabel(p)),
        p.name ? el('span.muted', {}, `#${participantNumber(p.n)}`) : null,
        p.hand ? icon('hand', 'icon person-hand') : null,
        el('span.grow'),
        confirmButton(t('kick'), t('confirmKick'), `p:${p.id}`, kick, armed));
    }));
    if (!room.people.length) peopleList.append(el('li.p-empty.muted', {}, t('noPeople')));

    let n = 1;
    presentersList.replaceChildren(...room.presenters.map((d) => {
      const kick = () => send({ t: 'kick-presenter', id: d.id });
      return el('li.person', {},
        icon('presenter', 'icon'),
        el('span.person-name', {}, d.you ? t('thisDevice') : t('deviceN', { n: n++ })),
        d.owner ? el('span.tag', {}, t('adminTag')) : null,
        d.windows > 1 ? el('span.muted', {}, t('windowsN', { n: d.windows })) : null,
        el('span.grow'),
        room.admin && !d.owner && !d.local && !d.you ? confirmButton(t('kick'), t('confirmKick'), `d:${d.id}`, kick, armed) : null);
    }));
  }

  // Keeps "2 min ago" fresh between updates.
  setInterval(() => { if (room && !handsPanel.hidden) renderHands(); }, 15_000);

  return {
    handsPanel,
    peoplePanel,
    get room() { return room; },
    update(msg) {
      room = msg;
      receivedAt = Date.now();
      renderHands();
      renderPeople();
    },
    handCount: () => (room ? room.people.filter((p) => p.hand).length : 0),
  };
}
