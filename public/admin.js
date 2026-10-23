// Admin panel: decks (upload, delete, featured, settings) and passwords.
import { t, el, api, setTitle } from './shell.js';

setTitle(t('admin'));
const app = document.getElementById('app');

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

function errorText(res) {
  const code = res.data?.error ?? res.status;
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
  app.append(el('header.admin-header', {},
    el('h1', {}, `syncdeck · ${t('admin')}`),
    el('div.row', {},
      el('a.button', { href: '/' }, t('decks')),
      // Without an admin password there is no session to sign out of.
      settings.hasAdminPassword ? el('button', { id: 'logout', onclick: logout }, t('signOut')) : null)));

  if (single) app.append(el('p.notice', {}, t('singleDeckMode')));

  // deck table
  const table = el('table.deck-table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, t('title')), el('th', {}, t('slug')), el('th', {}, t('size')),
      single ? null : el('th', {}, t('featured')), el('th', {}, t('actions')))),
    el('tbody', {}, decks.map((d) => el('tr', { dataset: { slug: d.slug } },
      el('td', {}, el('a', { href: `/${d.slug}` }, d.title)),
      el('td', {}, el('code', {}, d.slug)),
      el('td', {}, fmtSize(d.size)),
      single ? null : el('td', {}, el('input', {
        type: 'radio', name: 'featured', value: d.slug, checked: settings.featured === d.slug,
        title: t('featured'), onchange: () => setFeatured(d.slug),
      })),
      el('td.actions', {},
        el('a', { href: `/${d.slug}/view` }, t('viewer')),
        el('a', { href: `/${d.slug}/present` }, t('presenter')),
        el('a', { href: `/admin/edit/${d.slug}`, className: 'edit-link' }, t('edit')),
        el('button.small', { onclick: () => openSettings(d) }, t('settings')),
        single ? null : el('button.small.danger', { onclick: () => confirmDelete(d.slug) }, t('delete')))))),
    single ? null : el('tfoot', {}, el('tr', {},
      el('td', { colSpan: 3 }),
      el('td', {}, el('label.inline', {}, el('input', {
        type: 'radio', name: 'featured', value: '', checked: !settings.featured, onchange: () => setFeatured(null),
      }), ` ${t('none')}`)),
      el('td'))));
  app.append(el('h2', {}, t('decks')), decks.length ? el('div.table-wrap', {}, table) : el('p.muted', {}, t('noDecks')));

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
  // With a single deck, / always goes straight to it (D7): no list to show.
  const listingBlock = single ? null : el('div.listing', {},
    el('label.inline', { htmlFor: 'public-listing' }, listing, ` ${t('publicListing')}`), listingMsg,
    el('p.hint.muted', {}, t('publicListingHint')));
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
          ? t('adminPasswordSetHint', { cmd: 'syncdeck passwd admin --clear' })
          : t('adminPasswordUnsetHint'),
        onDone: load,
      })));
}

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
    const type = /\.zip$/i.test(f.name) ? 'application/zip' : 'text/html';
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

async function setFeatured(slug) {
  await api('/api/admin/settings', { method: 'PUT', body: { featured: slug } });
  settings.featured = slug;
}

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

function openSettings(d) {
  const title = el('input', { type: 'text', id: 'deck-title', value: d.title, maxLength: 200 });
  const mode = el('select', { id: 'deck-mode' },
    ['follow', 'back', 'free'].map((m) => el('option', { value: m, selected: d.viewerNav === m },
      t({ follow: 'modeFollow', back: 'modeBack', free: 'modeFree' }[m]))));
  const msg = el('span.status');
  const save = el('button.primary', {
    type: 'button',
    onclick: async () => {
      const res = await api(`/api/admin/decks/${encodeURIComponent(d.slug)}`, {
        method: 'PATCH', body: { title: title.value, viewerNav: mode.value },
      });
      status(msg, res.ok ? t('saved') : errorText(res), res.ok ? 'ok' : 'error');
    },
  }, t('save'));
  const dialog = el('dialog.card.deck-settings', {},
    el('h2', {}, `${t('settings')} · ${d.slug}`),
    el('label', { htmlFor: 'deck-title' }, t('title')), title,
    el('label', { htmlFor: 'deck-mode' }, t('defaultViewerMode')), mode,
    el('div.row', {}, save, msg),
    passwordControl({ label: t('deckPresenterPassword'), scope: 'deckPresenter', deck: d.slug, isSet: d.hasPresenterPassword }),
    passwordControl({ label: t('deckViewerPassword'), scope: 'deckViewer', deck: d.slug, isSet: d.hasViewerPassword }),
    el('div.row.end', {}, el('button', { type: 'button', onclick: () => dialog.close() }, t('close'))));
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
