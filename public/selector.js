// Deck selector: choose viewer or presenter mode.
import { t, el, api, slugFromPath, setTitle } from './shell.js';

const slug = slugFromPath();
const app = document.getElementById('app');
const info = await api(`/api/decks/${encodeURIComponent(slug)}`);
if (info.status === 403) location.replace(`/${slug}/login?as=viewer`);
const title = info.data?.title ?? slug;
setTitle(title);

app.append(
  el('h1.selector-title', {}, title),
  el('div.mode-buttons', {},
    el('a.mode-button', { href: `/${slug}/view`, id: 'go-viewer' },
      el('span.mode-name', {}, t('viewer')), el('span.mode-hint', {}, t('viewerHint'))),
    el('a.mode-button', { href: `/${slug}/present`, id: 'go-presenter' },
      el('span.mode-name', {}, t('presenter')), el('span.mode-hint', {}, t('presenterHint')))),
);
