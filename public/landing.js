import { t, el, setTitle, brand, logo, credit, siteName, appearance } from './shell.js';

setTitle('');
document.getElementById('app').append(
  brand(),
  el('section.hero', {},
    el('span.hero-mark', {}, logo('hero-logo')),
    el('h1', {}, siteName),
    el('p.muted', {}, appearance.landingText || t('landingText'))),
  credit(),
);
