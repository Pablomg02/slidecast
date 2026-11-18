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

// "42 s" under a minute, then whole minutes rounded up ("3 min").
export function formatWait(seconds) {
  return seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}

// After a 429 or 503 from /api/login: shows why, keeps the button off with a
// countdown on it, then gives it back and calls done(). The message is set
// once (it is an alert); only the button counts down.
export function holdLoginButton(button, message, res, done) {
  const seconds = Math.max(1, Number(res.data?.retryAfter) || 60);
  const busy = res.status === 503;
  message.textContent = busy ? t('loginBusy') : t('tooMany', { time: formatWait(seconds) });
  message.hidden = false;
  const label = button.textContent;
  const until = Date.now() + seconds * 1000;
  button.disabled = true;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left > 0) {
      button.textContent = t('waitButton', { time: formatWait(left) });
      return;
    }
    clearInterval(timer);
    button.textContent = label;
    button.disabled = false;
    if (!busy) message.hidden = true;
    done?.(busy);
  };
  const timer = setInterval(tick, 1000);
  tick();
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
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5v-6a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8.5a6.5 6.5 0 0 1-6.5 6.5h-.6a6 6 0 0 1-4.6-2.2L3.2 15a1.6 1.6 0 0 1 2.4-2.1L8 15"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  poll: '<path d="M5 20v-7M12 20V5M19 20v-10M3 20h18"/>',
  minimize: '<path d="M9 6l6 6-6 6"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  first: '<path d="M6 5v14"/><path d="M19 6v12l-9.5-6z" fill="currentColor"/>',
  last: '<path d="M18 5v14"/><path d="M5 6v12l9.5-6z" fill="currentColor"/>',
  remote: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  cross: '<path d="M7 7l10 10M17 7L7 17"/>',
  partial: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
  laser: '<circle cx="12" cy="12" r="3.5" fill="currentColor"/><path d="M12 2.5v3.5M12 18v3.5M2.5 12H6M18 12h3.5"/>',
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
  return el('a.brand', { href: '/' }, appearance.showLogo === false ? null : logo('brand-logo'), siteName);
}

// "Made with Slidecast" at the foot of the public pages, unless turned off
// (then an empty fragment, which the pages can append as it is).
export function credit() {
  if (appearance.showCredit === false) return document.createDocumentFragment();
  return el('footer.credit', {}, el('a', {
    href: 'https://github.com/Pablomg02/slidecast', target: '_blank', rel: 'noopener',
  }, logo('credit-logo'), t('madeWith', { name: 'Slidecast' })));
}

export function logo(cls) {
  return el(`img.${cls}`, { src: '/_slidecast/logo.svg', alt: '' });
}

// "W:H" → [W, H], positive integers; 16:9 for anything else.
export function parseAspect(aspect) {
  const m = /^(\d+):(\d+)$/.exec(String(aspect ?? ''));
  const w = m ? Number(m[1]) : 0;
  const h = m ? Number(m[2]) : 0;
  return w > 0 && h > 0 ? [w, h] : [16, 9];
}

// The layout key of a frozen deck ("1920x1080", 0010) → {w, h}; null when the
// deck is not frozen or the key is unusable.
export function parseLayout(layout) {
  const m = /^(\d+)x(\d+)$/.exec(typeof layout === 'string' ? layout : '');
  const w = m ? Number(m[1]) : 0;
  const h = m ? Number(m[2]) : 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

// Keeps a page on its deck's current layout (D7, D27 of 0010). `check(layout)`
// with the layout of each state snapshot: false when it differs from the one
// this page loaded with, and the page is reloading. A second reload for the
// same layout in this tab is refused (a warning instead), so a deck.json
// edited on disk can never make a page reload in a loop. Without
// sessionStorage the guard cannot remember, so it only warns: a real layout
// change still reloads the page through the close code `again`.
export function layoutGuard(slug, loaded) {
  const key = `sd-layout-reload:${slug}`;
  const mine = loaded ?? null;
  let reloading = false;
  let settled = false;
  const store = {
    get: () => { try { return sessionStorage.getItem(key); } catch { return null; } },
    set: (v) => { try { sessionStorage.setItem(key, v); return true; } catch { return false; } },
    clear: () => { try { sessionStorage.removeItem(key); } catch { /* private mode */ } },
  };
  return function check(layout) {
    const now = layout ?? null;
    if (now === mine) {
      if (!settled) store.clear();
      settled = true;
      return true;
    }
    if (reloading) return false;
    if (store.get() === String(now) || !store.set(String(now))) {
      console.warn(`slidecast: the deck's layout is ${now}, this page has ${mine}; not reloading again`);
      return true;
    }
    reloading = true;
    location.reload();
    return false;
  };
}

// A deck's thumbnail: its cover image when it has one, otherwise the deck
// itself rendered at desktop size (its virtual size when frozen) and scaled
// down (created once visible).
export function deckThumb({ cover, deckUrl, aspect = '16:9', locked, layout = null }) {
  const [aw, ah] = parseAspect(aspect);
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
  const virtual = parseLayout(layout) ?? { w: 1280, h: Math.round((1280 * ah) / aw) };
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    seen.disconnect();
    const frame = createDeckFrame(box, deckUrl, { mode: 'preview', virtual });
    frame.element.addEventListener('load', () => box.classList.add('loaded'));
  }, { rootMargin: '200px' });
  seen.observe(box);
  return box;
}

export function setTitle(title) {
  document.title = title ? `${title} · ${siteName}` : siteName;
}

// ---- live connection -------------------------------------------------------

// Close codes that end the connection for good (see CLOSE in src/live.js).
const FINAL = {
  4000: 'again', // the room opened or admits people again: reload
  4401: 'denied',
  4403: 'kicked',
  4404: 'denied',
  4410: 'presenters-full',
};

// A connection attempt that has not opened by then is dropped and retried.
const CONNECT_TIMEOUT_MS = 10_000;
// An open socket that does not answer a ping within this time is replaced.
const PONG_TIMEOUT_MS = 5000;

// WebSocket to /ws/<slug> with reconnect (0.5 s → 10 s). `hello()`, if given,
// is sent first on every connection; the last `meta` message is re-sent after
// every reconnect. onStatus gets "open", "reconnecting", "full" (the room is
// full: retrying) or, with no retry, one of FINAL's names.
//
// Phones freeze background pages: a socket opened just before may hang in
// "connecting" for good, and one left open may be dead without a close event.
// So an attempt has a time limit, and coming back to the page (visible again,
// restored from the back-forward cache, back online) retries a lost
// connection at once and pings an open one, replacing it if it does not answer.
export function connectLive(slug, role, onMessage, onStatus = () => {}, { hello } = {}) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/${encodeURIComponent(slug)}?role=${role}`;
  let ws = null;
  let delay = 500;
  let meta = null;
  let stopped = false; // closed by the page, or by a FINAL code
  let timer = null; // the next attempt, after a loss
  let probe = null; // waiting for an answer to a ping
  let resumed = null; // the socket opened on coming back, while it connects

  function open() {
    clearTimeout(timer);
    timer = null;
    clearTimeout(probe);
    probe = null;
    const sock = new WebSocket(url);
    ws = sock;
    // Given up by hand: the retry is scheduled here, not on a close event
    // that a frozen network stack may deliver late.
    const limit = setTimeout(() => {
      if (sock.readyState !== WebSocket.CONNECTING) return;
      sock.onclose = null;
      sock.close();
      if (sock === ws) lost(1006);
    }, CONNECT_TIMEOUT_MS);
    sock.onopen = () => {
      clearTimeout(limit);
      if (sock !== ws) return;
      delay = 500;
      onStatus('open');
      const first = hello?.();
      if (first) sock.send(JSON.stringify(first));
      if (meta) sock.send(JSON.stringify(meta));
    };
    sock.onmessage = (e) => {
      if (sock !== ws) return;
      clearTimeout(probe); // anything that arrives proves the socket works
      probe = null;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg?.t === 'pong') return;
      onMessage(msg);
    };
    sock.onclose = (e) => {
      clearTimeout(limit);
      if (sock === ws) lost(e.code); // else replaced: its successor carries on
    };
  }

  function lost(code) {
    clearTimeout(probe);
    probe = null;
    if (stopped) return;
    if (FINAL[code]) {
      stopped = true;
      onStatus(FINAL[code], code);
      return;
    }
    onStatus(code === 4409 ? 'full' : 'reconnecting');
    timer = setTimeout(open, delay);
    delay = Math.min(delay * 2, 10_000);
  }

  // A new socket now, the old one dropped without retrying for it.
  function renew() {
    const old = ws;
    delay = 500;
    open();
    resumed = ws;
    if (old) {
      old.onclose = null;
      old.close();
    }
  }

  // Back on the page. Several events may come for one return (visible again,
  // then pageshow): a socket just opened for it keeps its own time limit.
  function resume() {
    if (stopped || document.visibilityState === 'hidden') return;
    if (ws?.readyState === WebSocket.OPEN) {
      if (probe) return;
      const sock = ws;
      sock.send(JSON.stringify({ t: 'ping' }));
      probe = setTimeout(() => {
        probe = null;
        if (sock !== ws || stopped) return;
        onStatus('reconnecting');
        renew();
      }, PONG_TIMEOUT_MS);
      return;
    }
    if (ws?.readyState === WebSocket.CONNECTING && ws === resumed) return;
    renew();
  }
  function onVisibility() {
    if (document.visibilityState === 'hidden') resumed = null;
    else resume();
  }
  // Not on the first load: only a page restored from the back-forward cache.
  const onPageShow = (e) => { if (e.persisted) resume(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', resume);

  open();

  return {
    send(msg) {
      if (msg.t === 'meta') meta = msg;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(probe);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', resume);
      ws?.close();
    },
  };
}

// ---- deck frame ------------------------------------------------------------

// The deck runs in <iframe sandbox="allow-scripts"> (opaque origin, D4) and
// talks to us through the bridge's postMessage protocol. `swipe: false` stops
// horizontal swipes from moving the slides.
//
// `virtual: {w, h}` (frozen decks, 0010) draws the deck at that fixed CSS size
// in div.deck-virtual, scaled to fit the container and centred, so it lays
// itself out the same on every screen. div.deck-layer sits exactly over the
// displayed deck, for overlays such as pointer dots. Without it, nothing changes.
export function createDeckFrame(container, deckUrl, {
  mode = 'live', query = '', swipe = true, virtual = null,
} = {}) {
  const iframe = el('iframe.deck-frame', {
    sandbox: 'allow-scripts',
    // A deck's own fullscreen would show the bare iframe unscaled (D6 of 0010).
    allow: virtual ? 'autoplay' : 'fullscreen; autoplay',
    title: 'deck',
  });
  iframe.setAttribute('sandbox', 'allow-scripts');
  const handlers = { changed: [], input: [], error: [], ready: [] };
  const box = virtual ? el('div.deck-virtual') : null;
  const layer = virtual ? el('div.deck-layer') : null;
  let observer = null;
  const frame = {
    element: iframe,
    box,
    layer,
    scale: 1,
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
      postMode();
    },
    onChanged: (cb) => handlers.changed.push(cb),
    onInput: (cb) => handlers.input.push(cb),
    onError: (cb) => handlers.error.push(cb),
    onReady: (cb) => handlers.ready.push(cb),
    destroy() {
      window.removeEventListener('message', onMessage);
      observer?.disconnect();
      iframe.remove();
      box?.remove();
      layer?.remove();
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

  // Non-frozen frames send exactly the message they always did.
  function postMode() {
    post(virtual ? { t: 'mode', mode: frame.mode, swipe, scale: frame.scale } : { t: 'mode', mode: frame.mode, swipe });
  }

  // Contain-fit of the virtual size in the container, centred; offsets
  // rounded to device pixels so text stays crisp.
  function fit() {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    const s = Math.min(cw / virtual.w, ch / virtual.h);
    const dpr = window.devicePixelRatio || 1;
    const px = (v) => Math.round(v * dpr) / dpr;
    const dw = virtual.w * s;
    const dh = virtual.h * s;
    const x = px((cw - dw) / 2);
    const y = px((ch - dh) / 2);
    box.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    layer.style.left = `${x}px`;
    layer.style.top = `${y}px`;
    layer.style.width = `${dw}px`;
    layer.style.height = `${dh}px`;
    layer.style.setProperty('--ptr-size', `${Math.min(26, Math.max(8, 0.014 * dw))}px`);
    const changed = s !== frame.scale;
    frame.scale = s;
    if (changed && frame.readyState) postMode();
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
      postMode();
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
      if (acceptKey(m.action, m.repeat === true)) handlers.input.forEach((cb) => cb(m.action));
    } else if (m.t === 'error') {
      handlers.error.forEach((cb) => cb(m.code));
    }
  }
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', postMode);
  iframe.src = deckUrl + query;
  if (virtual) {
    box.style.width = `${virtual.w}px`;
    box.style.height = `${virtual.h}px`;
    box.append(iframe);
    container.append(box, layer);
    fit();
    observer = new ResizeObserver(fit);
    observer.observe(container);
  } else {
    container.append(iframe);
  }
  return frame;
}

// ---- keys ------------------------------------------------------------------

// Same table as the bridge, for when the focus is on the shell itself.
export function keyActionFromEvent(e) {
  const tgt = e.target;
  if (tgt && (tgt.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tgt.tagName))) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'Enter': case 'MediaTrackNext': return 'next';
    case ' ': return e.shiftKey ? 'prev' : 'next';
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': case 'MediaTrackPrevious': return 'prev';
    case 'Home': return 'first';
    case 'End': return 'last';
    case 'b': case 'B': case '.': return 'blank';
    // A clicker's "start" button sends F5 (then Esc, which leaves full screen
    // by itself): it must not reload the page in the middle of a talk.
    case 'f': case 'F': case 'F5': return 'fullscreen';
    case 'l': case 'L': return 'live';
    default: return null;
  }
}

// Holding a key down moves through the slides, at most one step every
// REPEAT_MS so the decks and the viewers keep up. Only next and previous
// repeat: a held B or F must not toggle on and off.
const REPEAT_MS = 100;
let lastKey = -Infinity;
export function acceptKey(action, repeat) {
  const now = performance.now();
  if (repeat && (action !== 'next' && action !== 'prev' || now - lastKey < REPEAT_MS)) return false;
  lastKey = now;
  return true;
}

// Buttons and links handle Enter/Space themselves.
export function isOwnKey(e) {
  return (e.key === 'Enter' || e.key === ' ') && e.target?.closest?.('button, a, summary');
}

export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// A button that asks once more before acting ("Remove?"), for 3 seconds.
// `armed` survives the list being redrawn while it waits. The button goes back
// to its label once it acts, or when it is no longer the one waiting: a button
// kept across updates (a poll card) must not stay on "Remove?".
export function confirmButton(label, confirmLabel, key, onConfirm, armed) {
  const btn = el('button.small.danger', { type: 'button' }, label);
  const waiting = () => armed.key === key && armed.until > Date.now();
  if (waiting()) btn.textContent = confirmLabel;
  btn.addEventListener('click', () => {
    if (waiting()) {
      armed.key = null;
      btn.textContent = label;
      onConfirm();
      return;
    }
    armed.key = key;
    armed.until = Date.now() + 3000;
    btn.textContent = confirmLabel;
    setTimeout(() => { if (!waiting()) btn.textContent = label; }, 3100);
  });
  return btn;
}

// "Participant 007", or the participant's name (D6 of 0003).
export function participantNumber(n) {
  return String(n).padStart(3, '0');
}
export function participantLabel({ n, name }) {
  return name || t('participantN', { n: participantNumber(n) });
}

export function stepLabel(step) {
  return step ? `${step.slide}${step.step ? ` · ${step.step}` : ''}` : '';
}
