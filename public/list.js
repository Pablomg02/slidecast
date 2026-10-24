// List of decks: shown to the admin, or to everyone when publicListing is on.
import { t, el, api, setTitle, brand, credit, icon, deckThumb } from './shell.js';

const app = document.getElementById('app');
setTitle(t('decks'));
const [res, session] = await Promise.all([api('/api/decks'), api('/api/session')]);
const decks = res.data?.decks ?? [];
app.append(el('header.list-head', {},
  brand(),
  session.data?.admin ? el('a.button', { href: '/admin' }, t('admin')) : null));
app.append(el('h1', {}, t('decks')));
if (!decks.length) app.append(el('p.empty.muted', {}, t('noDecks')));
app.append(el('ul.deck-grid', {}, decks.map((d) => el('li.deck-card', {},
  el('a.deck-cover', { href: `/${d.slug}`, tabIndex: -1 }, deckThumb(d)),
  el('div.deck-card-body', {},
    el('a.deck-link', { href: `/${d.slug}` }, d.locked ? icon('lock', 'icon icon-inline') : null, d.title),
    el('span.deck-actions', {},
      el('a', { href: `/${d.slug}/view` }, t('viewer')),
      el('a.quiet', { href: `/${d.slug}/present` }, t('presenter'))))))));
app.append(credit());
