// Limits on /api/login. A whole class often signs in from one school address
// at once, so only failed attempts count against an address, and each browser
// has its own tighter budget on top. Password checks (scrypt) wait their turn
// in a queue, so a crowd slows sign-ins down instead of the whole server.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const LOGIN_LIMITS = {
  // Per browser (the sc_device cookie): any attempt, then failures only.
  device: {
    attempts: [{ max: 3, ms: 5 * SECOND }],
    failures: [{ max: 10, ms: 15 * MINUTE }],
  },
  // Failures per address (IPv6: per /64) and password.
  perAddress: {
    admin: [{ max: 5, ms: MINUTE }, { max: 20, ms: HOUR }],
    presenter: [{ max: 10, ms: MINUTE }, { max: 50, ms: HOUR }],
    viewer: [{ max: 60, ms: MINUTE }, { max: 300, ms: HOUR }],
  },
  // Failures per password from all addresses together: guessing spread over
  // many machines. The admin's own machine (local direct) is never held back.
  overall: {
    admin: [{ max: 100, ms: HOUR }],
    presenter: [{ max: 300, ms: HOUR }],
    viewer: [{ max: 1000, ms: HOUR }],
  },
  // Password checks running at once, and waiting; beyond that: 503 busy.
  checks: { running: 2, queued: 200 },
};

const MAX_KEYS = 50_000;

// Events per key in sliding windows, e.g. [{max: 5, ms: 60000}, {max: 20, ms: 3600000}].
export function keyedLimit(windows, now = Date.now) {
  const longest = Math.max(...windows.map((w) => w.ms));
  const keep = Math.max(...windows.map((w) => w.max));
  const entries = new Map(); // key → event times, oldest first

  function times(key) {
    const t = entries.get(key);
    if (!t) return null;
    const cutoff = now() - longest;
    while (t.length && t[0] <= cutoff) t.shift();
    if (t.length) return t;
    entries.delete(key);
    return null;
  }

  function sweep() {
    for (const key of entries.keys()) times(key);
    // Still too many (a flood of new addresses): forget the oldest keys.
    for (const key of entries.keys()) {
      if (entries.size <= MAX_KEYS * 0.9) break;
      entries.delete(key);
    }
  }

  return {
    // Milliseconds until the key may have one more event (0: now).
    wait(key) {
      const t = times(key);
      if (!t) return 0;
      const n = now();
      let w = 0;
      for (const { max, ms } of windows) {
        if (t.length >= max) w = Math.max(w, t[t.length - max] + ms - n);
      }
      return Math.max(0, w);
    },
    // Records an event; the function returned takes it back.
    hit(key) {
      const t = times(key) ?? [];
      const at = now();
      t.push(at);
      if (t.length > keep) t.shift();
      entries.set(key, t);
      if (entries.size > MAX_KEYS) sweep();
      return () => {
        const i = t.lastIndexOf(at);
        if (i >= 0) t.splice(i, 1);
      };
    },
  };
}

export class BusyError extends Error {
  constructor(retryAfter) {
    super('busy');
    this.retryAfter = retryAfter;
  }
}

// Runs at most `running` tasks at once and queues up to `queued` more; past
// that, run() throws BusyError with the seconds the queue needs to drain.
export function createGate({ running, queued }) {
  let active = 0;
  let avgMs = 100;
  const waiting = [];

  const drainSeconds = () => Math.max(1, Math.ceil(((waiting.length + 1) * avgMs) / running / 1000));

  async function run(task) {
    if (active < running) {
      active++;
    } else {
      if (waiting.length >= queued) throw new BusyError(drainSeconds());
      await new Promise((resolve) => waiting.push(resolve)); // the slot is handed over
    }
    const start = performance.now();
    try {
      return await task();
    } finally {
      avgMs = avgMs * 0.8 + (performance.now() - start) * 0.2;
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  return { run, get queued() { return waiting.length; } };
}

// The key an address is limited by: IPv4 as it is, IPv6 by its /64 prefix,
// since one connection usually owns a whole /64.
export function addressKey(ip) {
  const s = String(ip).toLowerCase().replace(/%.*$/, '');
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = s.includes('::') && tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
