import { t, el, setTitle, brand, icon } from './shell.js';

setTitle('');
document.getElementById('app').append(
  brand(),
  el('section.hero', {},
    el('span.hero-mark', {}, icon('deck')),
    el('h1', {}, t('landingTitle')),
    el('p.muted', {}, t('landingText'))),
);
