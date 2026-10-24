import { t, el, setTitle, brand, credit } from './shell.js';

setTitle(t('notFound'));
document.getElementById('app').append(
  brand(),
  el('section.hero', {},
    el('p.hero-code', {}, '404'),
    el('h1', {}, t('notFound')),
    el('p.muted', {}, t('notFoundText')),
    el('p', {}, el('a.button', { href: '/' }, t('backHome')))),
  credit(),
);
