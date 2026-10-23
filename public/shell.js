// Shared shell library: i18n, API calls, the live WebSocket, the sandboxed
// deck frame and the key table. Every syncdeck page imports it.
import { t, lang } from './i18n.js';

export { t, lang };

document.documentElement.lang = lang;

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

export function setTitle(title) {
  document.title = title ? `${title} · syncdeck` : 'syncdeck';
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
