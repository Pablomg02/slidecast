import { t, el, setTitle } from './shell.js';

setTitle('');
document.getElementById('app').append(
  el('h1', {}, t('landingTitle')),
  el('p.muted', {}, t('landingText')),
);
