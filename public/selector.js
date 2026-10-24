// Deck selector: watching is the main action; presenting is the quiet one below.
import { t, el, api, slugFromPath, setTitle, brand, icon, deckThumb } from './shell.js';

const slug = slugFromPath();
const app = document.getElementById('app');
const info = await api(`/api/decks/${encodeURIComponent(slug)}`);
if (info.status === 403) location.replace(`/${slug}/login?as=viewer`);
const title = info.data?.title ?? slug;
setTitle(title);

app.append(
  brand(),
  el('header.selector-head', {},
    el('p.eyebrow', {}, t('presentation')),
    el('h1.selector-title', {}, title)),
  el('a.mode-viewer', { href: `/${slug}/view`, id: 'go-viewer' },
    el('div.mode-viewer-thumb', {}, deckThumb(info.data ?? {}), el('span.play', {}, icon('play', 'icon icon-fill'))),
    el('div.mode-viewer-body', {},
      el('span.mode-icon', {}, icon('screen')),
      el('span.mode-text', {}, el('span.mode-name', {}, t('viewer'))),
      el('span.mode-cta', {}, t('watch'), icon('arrow')))),
  el('a.mode-presenter', { href: `/${slug}/present`, id: 'go-presenter' },
    icon('presenter'),
    el('span.mode-text', {}, el('span.mode-name', {}, t('presenter'))),
    icon('arrow')),
);
