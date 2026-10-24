// Shared shell library: i18n, API calls, the live WebSocket, the sandboxed
// deck frame and the key table. Every slidecast page imports it.
import { t, lang } from './i18n.js';

export { t, lang };

document.documentElement.lang = lang;

// Cosmetic settings from /admin, put in a <meta> by the server.
export const appearance = (() => {
  try {
    return JSON.parse(document.querySelector('meta[name="slidecast-appearance"]')?.content ?? '{}');
  } catch {
    return {};
  }
})();
export const siteName = appearance.siteName || 'Slidecast';

// Small DOM helper: el('button.big', {onclick}, 'text', child…)
export function el(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && k !== 'list' && k !== 'form') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function slugFromPath() {
  return decodeURIComponent(location.pathname.split('/')[1] ?? '');
}

export async function api(path, { method = 'GET', body, raw, type } = {}) {
  const headers = {};
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers['Content-Type'] = type;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  let data = null;
  if (res.status !== 204) {
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  }
  return { status: res.status, ok: res.ok, data };
}

// ---- icons, brand, thumbnails -----------------------------------------------

const ICONS = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  presenter: '<rect x="3" y="3" width="18" height="12" rx="2"/><path d="M7 8h6M7 11h10M8 21l4-6 4 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="M6 15l6-6 6 6"/>',
  more: '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>',
};

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

export function brand() {
  return el('a.brand', { href: '/' }, logo('brand-logo'), siteName);
}

// "Made with Slidecast" at the foot of the public pages, unless turned off.
export function credit() {
  if (appearance.showCredit === false) return null;
  return el('footer.credit', {}, el('a', {
    href: 'https://github.com/Pablomg02/slidecast', target: '_blank', rel: 'noopener',
  }, t('madeWith', { name: 'Slidecast' })));
}

export function logo(cls) {
  return el(`img.${cls}`, { src: '/_slidecast/logo.svg', alt: '' });
}

// A deck's thumbnail: its cover image when it has one, otherwise the deck
// itself rendered at desktop size and scaled down (created once visible).
export function deckThumb({ cover, deckUrl, aspect = '16:9', locked }) {
  const [aw, ah] = String(aspect).split(':').map(Number);
  const box = el('div.thumb', { 'aria-hidden': 'true' });
  box.style.aspectRatio = `${aw} / ${ah}`;
  if (locked || !deckUrl) {
    box.classList.add('thumb-locked');
    box.append(icon('lock'));
    return box;
  }
  if (cover) {
    const img = el('img', { src: cover, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => box.classList.add('loaded'));
    img.addEventListener('error', () => {
      img.remove();
      box.classList.add('loaded');
    });
    box.append(img);
    return box;
  }
  const W = 1280;
  const inner = el('div.thumb-live');
  inner.style.width = `${W}px`;
  inner.style.height = `${Math.round((W * ah) / aw)}px`;
  box.append(inner);
  new ResizeObserver(() => { inner.style.transform = `scale(${box.clientWidth / W})`; }).observe(box);
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    seen.disconnect();
    const frame = createDeckFrame(inner, deckUrl, { mode: 'preview' });
    frame.element.addEventListener('load', () => box.classList.add('loaded'));
  }, { rootMargin: '200px' });
  seen.observe(box);
  return box;
}

export function setTitle(title) {
  document.title = title ? `${title} · ${siteName}` : siteName;
}

// ---- live connection -------------------------------------------------------

// WebSocket to /ws/<slug> with reconnect (0.5 s → 10 s). The last `meta`
// message is re-sent after every reconnect. onStatus gets "open",
// "reconnecting" or "denied" (4401/4404: no point retrying).
export function connectLive(slug, role, onMessage, onStatus = () => {}) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/${encodeURIComponent(slug)}?role=${role}`;
  let ws = null;
  let delay = 500;
  let meta = null;
  let stopped = false;
  let timer = null;

  function open() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 500;
      onStatus('open');
      if (meta) ws.send(JSON.stringify(meta));
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = (e) => {
      if (stopped) return;
      if (e.code === 4401 || e.code === 4404) {
        onStatus('denied', e.code);
        return;
      }
      onStatus('reconnecting');
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  }
  open();

  return {
    send(msg) {
      if (msg.t === 'meta') meta = msg;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}

// ---- deck frame ------------------------------------------------------------

// The deck runs in <iframe sandbox="allow-scripts"> (opaque origin, D4) and
// talks to us through the bridge's postMessage protocol.
export function createDeckFrame(container, deckUrl, { mode = 'live', query = '' } = {}) {
  const iframe = el('iframe.deck-frame', {
    sandbox: 'allow-scripts',
    allow: 'fullscreen; autoplay',
    title: 'deck',
  });
  iframe.setAttribute('sandbox', 'allow-scripts');
  const handlers = { changed: [], input: [], error: [], ready: [] };
  const frame = {
    element: iframe,
    steps: [],
    index: 0,
    adapter: null,
    mode,
    readyState: false,
    go(index) {
      requested.push({ index, at: Date.now() });
      post({ t: 'go', index });
    },
    setMode(m) {
      frame.mode = m;
      applyMode();
      post({ t: 'mode', mode: m });
    },
    onChanged: (cb) => handlers.changed.push(cb),
    onInput: (cb) => handlers.input.push(cb),
    onError: (cb) => handlers.error.push(cb),
    onReady: (cb) => handlers.ready.push(cb),
    destroy() {
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
  // Indices we asked for recently: a `changed` for one of them is our own
  // doing; any other `changed` means the deck moved by itself.
  let requested = [];
  let resolveReady;
  frame.ready = new Promise((r) => { resolveReady = r; });

  function post(msg) {
    iframe.contentWindow?.postMessage({ sd: 1, ...msg }, '*');
  }

  // A preview ignores all input, so it must never take the focus: keys
  // pressed after a click on it would be swallowed instead of reaching the page.
  function applyMode() {
    const preview = frame.mode === 'preview';
    iframe.classList.toggle('preview', preview);
    iframe.tabIndex = preview ? -1 : 0;
  }
  applyMode();

  function onMessage(e) {
    if (e.source !== iframe.contentWindow) return;
    const m = e.data;
    if (!m || m.sd !== 1) return;
    if (m.t === 'ready') {
      frame.steps = Array.isArray(m.steps) ? m.steps : [];
      frame.index = m.index;
      frame.adapter = m.adapter;
      frame.readyState = true;
      post({ t: 'mode', mode: frame.mode });
      resolveReady(m);
      handlers.ready.forEach((cb) => cb(m));
    } else if (m.t === 'changed') {
      frame.index = m.index;
      const now = Date.now();
      requested = requested.filter((r) => now - r.at < 3000);
      const at = requested.findIndex((r) => r.index === m.index);
      const own = at >= 0;
      if (own) requested = requested.slice(at); // keep it: a go may yield two changed
      handlers.changed.forEach((cb) => cb(m.index, own));
    } else if (m.t === 'input') {
      handlers.input.forEach((cb) => cb(m.action));
    } else if (m.t === 'error') {
      handlers.error.forEach((cb) => cb(m.code));
    }
  }
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', () => post({ t: 'mode', mode: frame.mode }));
  iframe.src = deckUrl + query;
  container.append(iframe);
  return frame;
}

// ---- keys ------------------------------------------------------------------

// Same table as the bridge, for when the focus is on the shell itself.
export function keyActionFromEvent(e) {
  const tgt = e.target;
  if (tgt && (tgt.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tgt.tagName))) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'Enter': return 'next';
    case ' ': return e.shiftKey ? 'prev' : 'next';
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': return 'prev';
    case 'Home': return 'first';
    case 'End': return 'last';
    case 'b': case 'B': case '.': return 'blank';
    case 'f': case 'F': return 'fullscreen';
    case 'l': case 'L': return 'live';
    default: return null;
  }
}

// Buttons and links handle Enter/Space themselves.
export function isOwnKey(e) {
  return (e.key === 'Enter' || e.key === ' ') && e.target?.closest?.('button, a, summary');
}

export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

export function stepLabel(step) {
  return step ? `${step.slide}${step.step ? ` · ${step.step}` : ''}` : '';
}
