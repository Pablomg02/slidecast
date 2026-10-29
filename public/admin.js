// Admin panel: decks (upload, update, download, delete, settings), their
// rooms (open, hidden or closed, limits) and passwords.
import { t, el, api, setTitle, brand, icon, createDeckFrame } from './shell.js';

setTitle(t('admin'));
const app = document.getElementById('app');
// The address people type to reach this server, shown instead of a bare "/".
const site = location.host;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function slugify(name) {
  return name.toLowerCase().replace(/\.(zip|html?)$/, '').normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

function status(node, text, kind = '') {
  node.textContent = text;
  node.className = `status ${kind}`;
}

const FRIENDLY = { 'password-too-short': 'passwordTooShort', 'password-too-weak': 'passwordTooWeak' };

function errorText(res) {
  const code = res.data?.error ?? res.status;
  if (FRIENDLY[code]) return t(FRIENDLY[code]);
  return res.data?.detail ? `${t('error', { code })}: ${res.data.detail}` : t('error', { code });
}

// A password row: input + Set (+ Remove), posting to /api/admin/passwords.
function passwordControl({ label, scope, deck, isSet, canClear = true, hint, onDone }) {
  const id = `pw-${scope}-${deck ?? 'all'}`;
  const input = el('input', { type: 'password', id, autocomplete: 'new-password', minLength: 8, placeholder: t('newPassword') });
  const msg = el('span.status');
  const state = el('span.muted', {}, ` (${isSet ? t('passwordSet') : t('passwordNotSet')})`);
  async function send(password) {
    const res = await api('/api/admin/passwords', { method: 'PUT', body: { scope, deck, password } });
    if (res.status === 204) {
      input.value = '';
      status(msg, t('saved'), 'ok');
      onDone?.();
    } else {
      status(msg, errorText(res), 'error');
    }
  }
  return el('div.password-control', {},
    el('label', { htmlFor: id }, label, state),
    el('div.row', {}, input,
      el('button', { type: 'button', onclick: () => send(input.value) }, t('setPassword')),
      canClear && isSet ? el('button.danger', { type: 'button', onclick: () => send(null) }, t('clearPassword')) : null),
    hint ? el('p.hint.muted', {}, hint) : null,
    msg);
}

let settings = null;
// --accent in style.css, shown by the colour input while no accent is set.
const DEFAULT_ACCENT = '#4f46e5';

const roomCells = new Map(); // slug → redraws that deck's room cell (roomCell)
let lastDecks = []; // the decks of the last render(), for the upload form

// "How updating works" (D20 of 0004): one popover for every ⓘ button, kept
// outside #app because render() empties it.
const updateInfo = el('div.card.info-pop', { id: 'update-info' },
  el('h3', {}, t('updateInfoTitle')),
  el('ul', {}, [1, 2, 3, 4, 5].map((n) => el('li', {}, t(`updateInfo${n}`)))));
updateInfo.setAttribute('popover', 'auto');
document.body.append(updateInfo);
let updateInfoFor = null; // the button it was last opened from

function updateInfoButton() {
  // Light dismiss closes the popover on pointerdown, before the click: without
  // this, a second click on the button would open it again.
  let wasOpen = false;
  const button = el('button.small.icon-btn.update-info-btn', {
    type: 'button',
    'aria-label': t('updateInfoLabel'),
    title: t('updateInfoLabel'),
    onpointerdown: () => { wasOpen = updateInfo.matches(':popover-open') && updateInfoFor === button; },
    onclick: () => {
      const closing = wasOpen || (updateInfo.matches(':popover-open') && updateInfoFor === button);
      wasOpen = false;
      if (closing) {
        if (updateInfo.matches(':popover-open')) updateInfo.hidePopover();
        return;
      }
      updateInfoFor = button;
      // Measured at the left edge: its width shrinks to the room left of it.
      updateInfo.style.left = '16px';
      updateInfo.showPopover();
      const r = button.getBoundingClientRect();
      const w = updateInfo.offsetWidth;
      const left = Math.min(Math.max(16, r.right - w), window.innerWidth - w - 16);
      updateInfo.style.left = `${Math.max(16, left)}px`;
      updateInfo.style.top = `${r.bottom + 6}px`;
      updateInfo.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 22)}px`;
    },
  }, icon('info'));
  return button;
}

async function load() {
  const [decksRes, settingsRes] = await Promise.all([api('/api/admin/decks'), api('/api/admin/settings')]);
  if (decksRes.status === 403) {
    location.reload();
    return;
  }
  settings = settingsRes.data;
  render(decksRes.data);
}

function render({ decks, single }) {
  app.replaceChildren();
  roomCells.clear();
  lastDecks = decks;
  app.append(el('header.admin-header', {},
    el('div.admin-title', {}, brand(), el('h1', {}, t('admin'))),
    el('div.row', {},
      el('a.button', { href: '/' }, t('decks')),
      // Without an admin password there is no session to sign out of.
      settings.hasAdminPassword ? el('button', { id: 'logout', onclick: logout }, t('signOut')) : null)));

  if (single) app.append(el('p.notice', {}, t('singleDeckMode')));

  // deck table
  const table = el('table.deck-table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, t('title')), el('th', {}, t('slug')), el('th', {}, t('size')),
      el('th', {}, t('room')), el('th', {}, t('actions')))),
    el('tbody', {}, decks.map((d) => el('tr', { dataset: { slug: d.slug } },
      el('td.deck-title', {}, el('a', { href: `/${d.slug}` }, d.title)),
      el('td.deck-slug', {}, el('code', {}, d.slug)),
      el('td.deck-size', {}, fmtSize(d.size)),
      el('td.deck-room', {}, roomCell(d, { single })),
      // Links on one line, buttons on the next (a flex <td> would break the row's borders).
      el('td.actions', {},
        el('div.action-links', {},
          el('a', { href: `/${d.slug}/view` }, t('viewer')),
          el('a', { href: `/${d.slug}/present` }, t('presenter')),
          el('a', { href: `/admin/edit/${d.slug}`, className: 'edit-link' }, t('edit')),
          el('a.download-link', { href: `/api/admin/decks/${encodeURIComponent(d.slug)}/download`, download: `${d.slug}.zip` }, t('download'))),
        el('div.action-buttons', {},
          el('button.small', { onclick: () => openSettings(d) }, t('settings')),
          single ? null : el('button.small.update-btn', { onclick: () => openUpdate(d) }, t('update')),
          single ? null : updateInfoButton(),
          single ? null : el('button.small.danger', { onclick: () => confirmDelete(d.slug) }, t('delete'))))))));
  app.append(el('h2', {}, t('decks')), decks.length ? el('div.table-wrap', {}, table) : el('p.muted', {}, t('noDecks')));
  if (decks.length && !single) app.append(el('p.hint.muted.room-hint', {}, t('roomHint', { site })));

  if (!single) app.append(uploadForm());

  // general settings
  const listing = el('input', {
    type: 'checkbox', id: 'public-listing', checked: settings.publicListing,
    onchange: async () => {
      const res = await api('/api/admin/settings', { method: 'PUT', body: { publicListing: listing.checked } });
      status(listingMsg, res.ok ? t('saved') : errorText(res), res.ok ? 'ok' : 'error');
    },
  });
  const listingMsg = el('span.status');
  // With a single deck there is no list to show (D7): / opens it, or shows the
  // landing page when it is hidden.
  const listingBlock = single ? null : el('div.listing', {},
    el('label.inline', { htmlFor: 'public-listing' }, listing, ` ${t('publicListing', { site })}`), listingMsg,
    el('p.hint.muted', {}, t('publicListingHint', { site })));
  app.append(el('h2', {}, t('generalSettings')),
    el('section.card.settings', {},
      listingBlock,
      passwordControl({
        label: t('globalPresenterPassword'),
        scope: 'presenter',
        isSet: settings.hasPresenterPassword,
        hint: settings.hasPresenterPassword ? null : t('presenterPasswordUnsetHint'),
        onDone: load,
      }),
      // The browser cannot remove the admin password, only the CLI can.
      passwordControl({
        label: t('adminPassword'),
        scope: 'admin',
        isSet: settings.hasAdminPassword,
        canClear: false,
        hint: settings.hasAdminPassword
          ? t('adminPasswordSetHint', { cmd: 'slidecast passwd admin --clear' })
          : t('adminPasswordUnsetHint'),
        onDone: load,
      })));

  app.append(el('h2', {}, t('appearance')), appearanceForm());
}

// Site name, home page message, accent colour, logo and credit (all cosmetic).
function appearanceForm() {
  const look = settings.appearance;
  const name = el('input', { type: 'text', id: 'site-name', value: look.siteName ?? '', placeholder: 'Slidecast', maxLength: 60 });
  const text = el('textarea', { id: 'landing-text', rows: 2, maxLength: 300, placeholder: t('landingText') });
  text.value = look.landingText ?? '';
  // A colour input always holds a colour: only send it once it was touched.
  let accent = look.accent;
  const color = el('input', {
    type: 'color', id: 'accent-color', value: look.accent ?? DEFAULT_ACCENT,
    oninput: () => { accent = color.value; },
  });
  const reset = el('button.small', {
    type: 'button',
    onclick: () => {
      accent = null;
      color.value = DEFAULT_ACCENT;
    },
  }, t('resetDefault'));
  const showLogo = el('input', { type: 'checkbox', id: 'show-logo', checked: look.showLogo !== false });
  const showCredit = el('input', { type: 'checkbox', id: 'show-credit', checked: look.showCredit !== false });
  const msg = el('span.status');
  const form = el('form.card.appearance-form', {},
    el('label', { htmlFor: 'site-name' }, t('siteName')), name,
    el('p.hint.muted', {}, t('siteNameHint')),
    el('label', { htmlFor: 'landing-text' }, t('landingTextLabel')), text,
    el('p.hint.muted', {}, t('landingTextHint', { site })),
    el('label', { htmlFor: 'accent-color' }, t('accentColor')),
    el('div.row.accent-row', {}, color, reset),
    el('label.inline.logo-toggle', { htmlFor: 'show-logo' }, showLogo, ` ${t('showLogo')}`),
    el('label.inline', { htmlFor: 'show-credit' }, showCredit, ` ${t('showCredit')}`),
    el('div.row', {}, el('button.primary', { type: 'submit' }, t('save')), msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/admin/settings', {
      method: 'PUT',
      body: { appearance: { siteName: name.value, landingText: text.value, accent, showLogo: showLogo.checked, showCredit: showCredit.checked } },
    });
    status(msg, res.ok ? t('saved') : errorText(res), res.ok ? 'ok' : 'error');
    // The name and colour belong to the page itself: reload to show them.
    if (res.ok) setTimeout(() => location.reload(), 600);
  });
  return form;
}

const uploadType = (f) => (/\.zip$/i.test(f.name) ? 'application/zip' : 'text/html');

function uploadForm() {
  const file = el('input', { type: 'file', id: 'upload-file', accept: '.zip,.html,.htm', required: true });
  const slug = el('input', { type: 'text', id: 'upload-slug', required: true, pattern: '[a-z0-9][a-z0-9-]{0,62}', autocomplete: 'off' });
  const msg = el('p.status');
  const button = el('button.primary', { type: 'submit' }, t('uploadBtn'));
  file.addEventListener('change', () => {
    if (file.files[0]) slug.value = slugify(file.files[0].name);
  });
  const form = el('form.card.upload-form', {},
    el('p.muted', {}, t('uploadHint')),
    el('label', { htmlFor: 'upload-file' }, t('file')), file,
    el('label', { htmlFor: 'upload-slug' }, t('slug')), slug,
    el('div.row', {}, button), msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = file.files[0];
    if (!f) return;
    // An existing name goes through the update, which shows what happens to
    // its notes before anything changes (D16 of 0004).
    const existing = lastDecks.find((d) => d.slug === slug.value);
    if (existing) {
      openUpdate(existing, f);
      return;
    }
    const type = uploadType(f);
    button.disabled = true;
    status(msg, t('uploading'));
    const res = await api(`/api/admin/decks?slug=${encodeURIComponent(slug.value)}`, { method: 'POST', raw: f, type });
    button.disabled = false;
    if (res.status === 201) {
      await load();
      status(document.querySelector('.upload-form .status'), t('uploaded'), 'ok');
    } else {
      status(msg, errorText(res), 'error');
    }
  });
  return el('div', {}, el('h2', {}, t('upload')), form);
}

// Open / hidden / closed switch and live counts (D1, D3 of 0003). A hidden
// room is open but left out of the list and of the redirect at /. In
// single-deck mode the room is always open, but can be hidden.
const ROOM_STATES = {
  open: { label: 'roomOpen', patch: { open: true, listed: true } },
  hidden: { label: 'roomHidden', patch: { open: true, listed: false } },
  closed: { label: 'roomClosed', patch: { open: false } },
};
const roomState = (room) => (!room.open ? 'closed' : room.listed ? 'open' : 'hidden');

function roomCell(d, { single }) {
  const room = { ...d.room };
  const counts = el('span.room-counts.muted');
  const buttons = Object.entries(ROOM_STATES).map(([state, { label, patch }]) => el(`button.small.room-state.is-${state}`, {
    type: 'button', dataset: { state }, disabled: single && state === 'closed',
    title: state === 'hidden' ? t('roomHiddenTitle', { site }) : undefined,
    // Sent even when already pressed: the cell may be up to one poll behind.
    onclick: () => setRoom(d.slug, patch),
  }, el('span.dot'), t(label)));
  // Redrawn in place by the poll below, so a room opened or closed elsewhere
  // (the presenter view, another tab) shows here.
  const update = (fresh) => {
    Object.assign(room, fresh);
    const now = roomState(room);
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.state === now));
    counts.hidden = !room.open;
    counts.textContent = t('roomCounts', { v: room.viewers, p: room.presenters, h: room.raised });
  };
  update(room);
  roomCells.set(d.slug, update);
  return el('div.room-cell', {}, el('div.room-states', { role: 'group', 'aria-label': t('room') }, buttons), counts);
}

async function setRoom(slug, patch) {
  const res = await api(`/api/admin/rooms/${encodeURIComponent(slug)}`, { method: 'PATCH', body: patch });
  if (res.ok) await load();
}

// Room state and live counts, refreshed in place (a full redraw would reset the forms).
setInterval(async () => {
  if (document.hidden || document.querySelector('dialog[open]')) return;
  const res = await api('/api/admin/decks');
  if (!res.ok) return;
  for (const d of res.data.decks) roomCells.get(d.slug)?.(d.room);
}, 5000);

function confirmDelete(slug) {
  const input = el('input', { type: 'text', id: 'confirm-slug', autocomplete: 'off' });
  const ok = el('button.danger', { type: 'submit', id: 'confirm-delete', disabled: true }, t('delete'));
  const msg = el('p.status');
  input.addEventListener('input', () => { ok.disabled = input.value !== slug; });
  const form = el('form', { method: 'dialog' },
    el('p', {}, t('deleteConfirm', { slug })), input, msg,
    el('div.row', {}, el('button', { type: 'button', onclick: () => dialog.close() }, t('close')), ok));
  const dialog = el('dialog.card', {}, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value !== slug) return;
    const res = await api(`/api/admin/decks/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    if (res.status === 204) {
      dialog.close();
      await load();
    } else {
      status(msg, errorText(res), 'error');
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}

// The new deck may never report its slides (no deck API): after this long the
// notes are kept unchecked (D8 of 0004).
const PROBE_TIMEOUT = 15000;

// Update a deck in two phases (0004): stage the new version, load it in a
// preview to learn its slides, show what happens to the notes, then commit.
function openUpdate(d, initialFile = null) {
  let stage = null; // the stage POST answer, while the stage exists
  let diff = null;
  let steps = null;
  let source = 'current';
  let frame = null;
  let closed = false;
  let committing = false;

  const input = el('input', { type: 'file', id: 'update-file', accept: '.zip,.html,.htm' });
  const check = el('button', { type: 'button', id: 'update-check', onclick: () => start(input.files[0]) }, t('updateCheck'));
  const picker = el('div.row.update-picker', {}, input, check);
  const fileName = el('p.update-file-name', { hidden: true });
  const msg = el('p.status');
  const probe = el('div.stage-probe', { hidden: true });
  const sourceBox = el('div.notes-source', { hidden: true });
  const summary = el('div.update-summary', { hidden: true });
  const outcome = el('div.update-outcome', { hidden: true });
  const confirm = el('button.primary', { type: 'button', id: 'update-confirm', disabled: true, onclick: commit }, t('updateConfirm'));
  const close = el('button', { type: 'button', onclick: () => dialog.close() }, t('close'));
  const dialog = el('dialog.card.update-dialog', {},
    el('h2', {}, t('updateTitle', { slug: d.slug })),
    el('p.hint.muted.update-intro', {}, t('updateIntro')),
    picker, fileName, msg, probe, sourceBox, summary, outcome,
    el('div.row.end', {}, close, confirm));

  const live = () => stage.live.presenters + stage.live.viewers > 0;
  const choice = () => stage.hasIncoming && !stage.same && !stage.incomingInvalid;

  // The new deck's slides, from the preview: null when it reports none.
  function probeSteps(deckUrl) {
    probe.hidden = false;
    frame = createDeckFrame(probe, deckUrl, { mode: 'preview' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), PROBE_TIMEOUT);
      frame.onReady((m) => {
        clearTimeout(timer);
        resolve((m.steps ?? []).map(({ slide, step }) => ({ slide, step })));
      });
      frame.onError(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  async function start(f) {
    if (!f) return;
    check.disabled = true;
    input.disabled = true;
    status(msg, t('updateChecking'));
    const res = await api(`/api/admin/decks/${encodeURIComponent(d.slug)}/stage`, { method: 'POST', raw: f, type: uploadType(f) });
    if (closed) {
      if (res.status === 201) api(`/api/admin/stages/${res.data.id}`, { method: 'DELETE' });
      return;
    }
    if (res.status !== 201) {
      status(msg, errorText(res), 'error');
      check.disabled = false;
      input.disabled = false;
      return;
    }
    stage = res.data;
    steps = await probeSteps(stage.deckUrl);
    if (closed) return;
    const sum = await api(`/api/admin/stages/${stage.id}/diff`, { method: 'POST', body: { steps } });
    if (closed) return;
    if (!sum.ok) {
      status(msg, sum.data?.error === 'stage-gone' ? t('updateExpired') : errorText(sum), 'error');
      return;
    }
    diff = sum.data;
    status(msg, '');
    if (choice()) drawSource();
    draw();
  }

  function drawSource() {
    const radio = (value, label) => el('label.inline', {},
      el('input', {
        type: 'radio', name: 'notes-source', value, checked: value === source,
        onchange: () => { source = value; draw(); },
      }), ` ${label}`);
    sourceBox.replaceChildren(
      radio('current', t('notesCurrent')),
      radio('incoming', t('notesIncoming')),
      el('p.hint.muted', {}, t('notesSourceHint')));
    sourceBox.hidden = false;
  }

  function draw() {
    const sum = source === 'incoming' ? diff.incoming : diff.current;
    const p = (text) => el('p', {}, text);
    const list = (items) => items.join(', ');
    const stepItems = sum.removedSteps.map((s) => `${s.slide}·${s.step}`);
    // replaceChildren() would print a null as "null".
    summary.replaceChildren(...[
      p(t('updateKept', { n: sum.kept })),
      sum.removedSlides.length ? p(t('updateRemovedSlides', { list: list(sum.removedSlides) })) : null,
      stepItems.length ? p(t('updateRemovedSteps', { list: list(stepItems) })) : null,
      sum.checked ? null : el('p.notice', {}, t('updateUnchecked')),
      sum.positional ? el('p.notice', {}, t('updatePositional')) : null,
      live() ? el('p.notice', {}, t('updateLive', { v: stage.live.viewers, p: stage.live.presenters })) : null,
      stage.incomingInvalid ? el('p.notice', {}, t('updateIncomingInvalid')) : null,
    ].filter(Boolean));
    summary.hidden = false;

    const removed = [...sum.removedSlides, ...stepItems];
    const items = [t('outcomeReplace')];
    if (sum.checked) {
      items.push(t('outcomeKeep', { n: sum.kept }));
      items.push(removed.length ? t('outcomeDelete', { list: list(removed) }) : t('outcomeDeleteNone'));
    } else {
      items.push(t('outcomeKeepAll'));
    }
    if (source === 'incoming') items.push(t('outcomeSettingsIncoming'));
    else if (stage.hasIncoming && !stage.same) items.push(t('outcomeSettingsCurrent'));
    if (live()) items.push(t('outcomeReload'));
    items.push(t('outcomeTrash'));
    outcome.replaceChildren(el('strong', {}, t('updateOutcome')), el('ul', {}, items.map((x) => el('li', {}, x))));
    outcome.hidden = false;
    confirm.disabled = false;
  }

  async function commit() {
    committing = true;
    confirm.disabled = true;
    close.disabled = true;
    const res = await api(`/api/admin/stages/${stage.id}/commit`, { method: 'POST', body: { notes: source, steps } });
    committing = false;
    close.disabled = false;
    const code = res.data?.error;
    // These answers mean the server no longer has this stage; after any other
    // error the dialog's close still discards it.
    if (res.ok || ['stage-gone', 'deck-changed', 'bad-deck-json'].includes(code)) stage = null;
    else confirm.disabled = false;
    if (res.ok) {
      dialog.close();
      await load();
      const node = document.querySelector('.upload-form .status');
      if (node) status(node, t('updated'), 'ok');
      return;
    }
    status(msg, code === 'stage-gone' ? t('updateExpired') : code === 'deck-changed' ? t('updateConflict') : errorText(res), 'error');
  }

  dialog.addEventListener('cancel', (e) => {
    if (committing) e.preventDefault();
  });
  dialog.addEventListener('close', () => {
    closed = true;
    frame?.destroy();
    if (stage) api(`/api/admin/stages/${stage.id}`, { method: 'DELETE' });
    stage = null;
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  if (initialFile) {
    picker.hidden = true;
    fileName.textContent = initialFile.name;
    fileName.hidden = false;
    start(initialFile);
  }
}

const MODE_LABELS = { follow: 'modeFollow', back: 'modeBack', free: 'modeFree' };
const MODE_HINTS = { follow: 'modeFollowHint', back: 'modeBackHint', free: 'modeFreeHint' };

function openSettings(d) {
  const title = el('input', { type: 'text', id: 'deck-title', value: d.title, maxLength: 200 });
  const mode = el('select', { id: 'deck-mode' },
    ['follow', 'back', 'free'].map((m) => el('option', { value: m, selected: d.viewerNav === m },
      t(MODE_LABELS[m]))));
  const modeHint = el('p.hint.muted.mode-hint');
  const describeMode = () => { modeHint.textContent = `${t(MODE_HINTS[mode.value])} ${t('modeDefaultHint')}`; };
  mode.addEventListener('change', describeMode);
  describeMode();
  const maxPresenters = el('input', { type: 'number', id: 'room-presenters', min: 1, max: 20, step: 1, value: d.room.maxPresenters });
  const maxViewers = el('input', { type: 'number', id: 'room-viewers', min: 1, max: 1000, step: 1, value: d.room.maxViewers });
  const askNames = el('input', { type: 'checkbox', id: 'room-names', checked: d.room.askNames });
  const hands = el('input', { type: 'checkbox', id: 'room-hands', checked: d.room.hands });
  const msg = el('span.status');
  const save = el('button.primary', {
    type: 'button',
    onclick: async () => {
      const res = await api(`/api/admin/decks/${encodeURIComponent(d.slug)}`, {
        method: 'PATCH', body: { title: title.value, viewerNav: mode.value },
      });
      const room = res.ok && await api(`/api/admin/rooms/${encodeURIComponent(d.slug)}`, {
        method: 'PATCH',
        body: {
          maxPresenters: Number(maxPresenters.value),
          maxViewers: Number(maxViewers.value),
          askNames: askNames.checked,
          hands: hands.checked,
        },
      });
      const failed = !res.ok ? res : !room.ok ? room : null;
      status(msg, failed ? errorText(failed) : t('saved'), failed ? 'error' : 'ok');
    },
  }, t('saveChanges'));
  const dialog = el('dialog.card.deck-settings', {},
    el('h2', {}, `${t('settings')} · ${d.slug}`),
    el('label', { htmlFor: 'deck-title' }, t('title')), title,
    el('label', { htmlFor: 'deck-mode' }, t('defaultViewerMode')), mode, modeHint,
    el('h3.settings-sub', {}, t('roomSettings')),
    el('div.room-limits', {},
      el('div', {}, el('label', { htmlFor: 'room-presenters' }, t('maxPresenters')), maxPresenters),
      el('div', {}, el('label', { htmlFor: 'room-viewers' }, t('maxViewers')), maxViewers)),
    el('label.inline', { htmlFor: 'room-names' }, askNames, ` ${t('askNamesSetting')}`),
    el('label.inline', { htmlFor: 'room-hands' }, hands, ` ${t('handsSetting')}`),
    el('div.row', {}, save, msg),
    el('h3.settings-sub.settings-break', {}, t('passwordsHeading')),
    el('p.hint.muted', {}, t('passwordsHint')),
    passwordControl({ label: t('deckPresenterPassword'), scope: 'deckPresenter', deck: d.slug, isSet: d.hasPresenterPassword }),
    passwordControl({ label: t('deckViewerPassword'), scope: 'deckViewer', deck: d.slug, isSet: d.hasViewerPassword }),
    el('div.row.end.settings-foot', {}, el('button', { type: 'button', onclick: () => dialog.close() }, t('close'))));
  dialog.addEventListener('close', () => {
    dialog.remove();
    load();
  });
  document.body.append(dialog);
  dialog.showModal();
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
}

load();
