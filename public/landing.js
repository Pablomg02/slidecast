import { t, el, setTitle, brand, logo } from './shell.js';

setTitle('');
document.getElementById('app').append(
  brand(),
  el('section.hero', {},
    el('span.hero-mark', {}, logo('hero-logo')),
    el('h1', {}, t('landingTitle')),
    el('p.muted', {}, t('landingText'))),
);
