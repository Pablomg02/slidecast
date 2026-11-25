// The join screen on the projector (0011): a QR code, the address to type and,
// if the room shows it, the viewer password. Only screens with presenter
// rights receive it; it covers the slide while the presenter shows it.
import { t, el } from './shell.js';
import { qrMatrix } from './qr.js';

const SVG = 'http://www.w3.org/2000/svg';
const QUIET = 4; // light modules around the code, as the standard asks

// The code as an SVG: one path, a horizontal run of dark modules per segment.
export function qrSvg(text) {
  const m = qrMatrix(text);
  if (!m) return null;
  const n = m.length + QUIET * 2;
  let d = '';
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (!m[y][x]) continue;
      let run = 1;
      while (x + run < m.length && m[y][x + run]) run++;
      d += `M${x + QUIET} ${y + QUIET}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', text);
  svg.setAttribute('class', 'share-qr');
  const bg = document.createElementNS(SVG, 'rect');
  bg.setAttribute('width', String(n));
  bg.setAttribute('height', String(n));
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

export function createShareScreen(app, { title }) {
  const qrBox = el('div.share-qr-box', { id: 'share-qr' });
  const url = el('p.share-url', { id: 'share-url' });
  const scan = el('p.share-scan', {}, t('joinScan'));
  const passwordValue = el('span.share-password-value', { id: 'share-password' });
  const password = el('p.share-password', { hidden: true }, el('span.share-password-label', {}, t('joinPassword')), passwordValue);
  const ask = el('p.share-ask', { id: 'share-ask', hidden: true }, t('joinAskPassword'));
  const none = el('p.share-none', { id: 'share-none', hidden: true }, t('joinNoAddress'));
  const overlay = el('div.share-overlay', { id: 'share', hidden: true },
    el('div.share-card', {},
      qrBox,
      el('div.share-text', {},
        el('p.share-deck', {}, title),
        el('h2.share-title', {}, t('joinTitle')),
        scan, url, password, ask, none)));
  app.append(overlay);

  let msg = null;
  let blank = false;
  let drawn = null; // the address the QR code shows now
  function render() {
    overlay.hidden = !msg?.shown || blank;
    if (overlay.hidden) return;
    if (drawn !== msg.url) {
      drawn = msg.url;
      qrBox.replaceChildren(...(msg.url ? [qrSvg(msg.url)].filter(Boolean) : []));
    }
    qrBox.hidden = !msg.url;
    scan.hidden = !msg.url;
    url.hidden = !msg.url;
    url.textContent = msg.text ?? '';
    none.hidden = Boolean(msg.url);
    password.hidden = !msg.password;
    passwordValue.textContent = msg.password ?? '';
    ask.hidden = Boolean(msg.password) || !msg.protected;
  }
  return {
    update(m) {
      msg = m;
      render();
    },
    setBlank(on) {
      blank = on;
      render();
    },
    get visible() {
      return !overlay.hidden;
    },
  };
}
