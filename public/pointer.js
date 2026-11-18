// Shared pointer (0010): presenters' laser dots drawn over a frozen deck, and
// the sender that turns mouse moves into a few small messages.

// One colour per presenter device (D22); classes .ptr-c0….ptr-c5 in style.css.
export const PTR_COLORS = ['#ff2d55', '#ffcc00', '#34c759', '#0a84ff', '#ff9500', '#bf5af2'];

// A dot that gets no message for this long is hidden: a lost "off" never
// leaves one behind (D19). The sender repeats a still position every 1.5 s.
const REMOTE_TIMEOUT_MS = 4000;

// Dots in `layer` (the frame's .deck-layer); x and y are 0..10000 of the slide.
// Remote dots are keyed by their slot id, the presenter's own by 'self'.
export function createPointerLayer(layer) {
  const dots = new Map(); // key → { node, timer }
  function hide(key) {
    const d = dots.get(key);
    if (!d) return;
    clearTimeout(d.timer);
    d.node.remove();
    dots.delete(key);
  }
  return {
    show(key, colorId, x, y) {
      let d = dots.get(key);
      const cls = `ptr-dot ptr-c${((colorId % PTR_COLORS.length) + PTR_COLORS.length) % PTR_COLORS.length}`;
      if (!d) {
        d = { node: document.createElement('span'), timer: null };
        dots.set(key, d);
        layer.append(d.node);
      }
      if (d.node.className !== cls) d.node.className = cls;
      d.node.style.left = `${x / 100}%`;
      d.node.style.top = `${y / 100}%`;
      clearTimeout(d.timer);
      if (key !== 'self') d.timer = setTimeout(() => hide(key), REMOTE_TIMEOUT_MS);
    },
    hide,
    clear() {
      for (const key of [...dots.keys()]) hide(key);
    },
  };
}

const MIN_GAP_MS = 66; // at most ~15 positions a second (D17)
const KEEP_ALIVE_MS = 1500; // a still dot is repeated so it stays (D20)

// Throttles positions to `send`: the latest one every 66 ms at most, a still
// one again every 1.5 s, and `off()` at once, cancelling anything pending.
export function createPointerSender(send) {
  let last = null; // the last position sent, {x, y}
  let pending = null; // the latest position not sent yet
  let lastAt = -Infinity;
  let trailing = null;
  let keepAlive = null;

  function flush() {
    trailing = null;
    if (!pending) return;
    const p = pending;
    pending = null;
    if (last && last.x === p.x && last.y === p.y) return;
    emit(p);
  }

  function emit(p) {
    last = p;
    lastAt = performance.now();
    send({ t: 'ptr', x: p.x, y: p.y });
    clearInterval(keepAlive);
    keepAlive = setInterval(() => {
      lastAt = performance.now();
      send({ t: 'ptr', x: last.x, y: last.y });
    }, KEEP_ALIVE_MS);
  }

  return {
    move(x, y) {
      pending = { x, y };
      if (trailing) return;
      const wait = lastAt + MIN_GAP_MS - performance.now();
      if (wait <= 0) flush();
      else trailing = setTimeout(flush, wait);
    },
    off() {
      clearTimeout(trailing);
      trailing = null;
      clearInterval(keepAlive);
      keepAlive = null;
      pending = null;
      const was = last;
      last = null;
      lastAt = -Infinity;
      if (was) send({ t: 'ptr', off: true });
    },
  };
}
