import { t, el, setTitle } from './shell.js';

setTitle(t('notFound'));
document.getElementById('app').append(
  el('h1', {}, t('notFound')),
  el('p.muted', {}, t('notFoundText')),
  el('p', {}, el('a', { href: '/' }, t('backHome'))),
);
