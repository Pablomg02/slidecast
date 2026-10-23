// List of decks: shown to the admin, or to everyone when publicListing is on.
import { t, el, api, setTitle } from './shell.js';

const app = document.getElementById('app');
setTitle(t('decks'));
const res = await api('/api/decks');
const decks = res.data?.decks ?? [];
app.append(el('h1', {}, t('decks')));
if (!decks.length) app.append(el('p.muted', {}, t('noDecks')));
app.append(el('ul.deck-list', {}, decks.map((d) => el('li', {},
  el('a.deck-link', { href: `/${d.slug}` }, d.title),
  el('span.deck-actions', {},
    el('a', { href: `/${d.slug}/view` }, t('viewer')),
    el('a', { href: `/${d.slug}/present` }, t('presenter')))))));
const session = await api('/api/session');
if (session.data?.admin) app.append(el('p', {}, el('a', { href: '/admin' }, t('admin'))));
