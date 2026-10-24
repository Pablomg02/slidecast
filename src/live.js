import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';
import { originMatches } from './security.js';
import { VIEWER_NAV } from './decks.js';
import { clientIp } from './auth.js';

export const MAX_MESSAGE = 4096;
const HEARTBEAT_MS = 25_000;
const MAX_TOTAL = 100_000;
// Connection caps (D5 of 0002): high enough for a classroom behind one NAT address.
const WS_LIMITS = { perIp: 100, total: 1000 };

// Per-deck live state, role-checked commands and broadcasts (D2, D3, D15, D25, D26).
export async function createLive(ctx, { heartbeatMs = HEARTBEAT_MS } = {}) {
  const livePath = join(ctx.stateDir, 'live.json');
  const persisted = await readJson(livePath, {}).catch(() => ({}));
  const decks = new Map(); // slug → {index, total, blank, viewerNav, rev, clients}
  const wsLimits = { ...WS_LIMITS, ...ctx.wsLimits };
  const perIp = new Map(); // address → open connections
  let open = 0;

  let persistTimer = null;
  function persistNow() {
    clearTimeout(persistTimer);
    persistTimer = null;
    const out = { ...persisted };
    for (const [slug, s] of decks) out[slug] = { index: s.index, blank: s.blank };
    Object.assign(persisted, out);
    return writeJsonAtomic(livePath, out);
  }
  function persistSoon() {
    if (!persistTimer) persistTimer = setTimeout(() => persistNow().catch(() => {}), 1000);
  }

  async function stateOf(slug) {
    let s = decks.get(slug);
    if (s) return s;
    const meta = await ctx.decks.readMeta(slug);
    s = decks.get(slug); // another connection may have created it meanwhile
    if (s) return s;
    const saved = persisted[slug] ?? {};
    s = {
      index: Number.isInteger(saved.index) && saved.index >= 0 ? saved.index : 0,
      total: 0,
      blank: saved.blank === true,
      viewerNav: meta.viewerNav,
      rev: 0,
      clients: new Set(),
    };
    decks.set(slug, s);
    return s;
  }

  function snapshot(s) {
    let presenters = 0;
    for (const c of s.clients) if (c.role === 'presenter') presenters++;
    return {
      t: 'state',
      index: s.index,
      total: s.total,
      blank: s.blank,
      viewerNav: s.viewerNav,
      rev: s.rev,
      presenters,
      viewers: s.clients.size - presenters,
    };
  }

  function send(client, msg) {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(msg));
  }

  function broadcast(s) {
    const msg = snapshot(s);
    for (const c of s.clients) send(c, msg);
  }

  function clamp(s, i) {
    const max = s.total > 0 ? s.total - 1 : Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.min(max, i));
  }

  // Applies one presenter command; returns true if the state changed.
  function apply(s, msg) {
    const before = `${s.index}|${s.total}|${s.blank}|${s.viewerNav}`;
    switch (msg.t) {
      case 'meta':
        if (!Number.isInteger(msg.total) || msg.total < 1 || msg.total > MAX_TOTAL) return null;
        s.total = Math.max(s.total, msg.total);
        s.index = clamp(s, s.index);
        break;
      case 'step':
        if (msg.delta !== 1 && msg.delta !== -1) return null;
        s.index = clamp(s, s.index + msg.delta);
        break;
      case 'goto':
        if (!Number.isInteger(msg.index) || msg.index < 0) return null;
        s.index = clamp(s, msg.index);
        break;
      case 'blank':
        if (typeof msg.on !== 'boolean') return null;
        s.blank = msg.on;
        break;
      case 'nav':
        if (!VIEWER_NAV.includes(msg.mode)) return null;
        s.viewerNav = msg.mode;
        break;
      default:
        return null;
    }
    return `${s.index}|${s.total}|${s.blank}|${s.viewerNav}` !== before;
  }

  const COMMANDS = new Set(['meta', 'step', 'goto', 'blank', 'nav']);

  async function handleConnection(socket, req) {
    const ip = clientIp(req, ctx.trustProxy);
    if (open >= wsLimits.total || (perIp.get(ip) ?? 0) >= wsLimits.perIp) {
      return socket.close(4429, 'too-many-connections');
    }
    open++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    socket.on('close', () => {
      open--;
      const n = perIp.get(ip) - 1;
      if (n > 0) perIp.set(ip, n);
      else perIp.delete(ip);
    });

    const slug = req.params.slug;
    const role = req.query?.role ?? 'viewer';
    const queue = [];
    let client = null;
    socket.on('message', (data) => {
      if (client) onMessage(client, data);
      else queue.push(data);
    });

    if (!(await ctx.decks.exists(slug))) return socket.close(4404, 'no-deck');
    if (role !== 'viewer' && role !== 'presenter') return socket.close(4400, 'bad-role');
    const allowed = role === 'presenter' ? ctx.auth.canPresent(req, slug) : ctx.auth.canView(req, slug);
    if (!allowed) return socket.close(4401, 'unauthorized');

    const s = await stateOf(slug);
    // The socket may have closed during the awaits; its close event is gone.
    if (socket.readyState !== 1) return undefined;
    client = { socket, role, req, slug, missed: 0 };
    s.clients.add(client);
    socket.on('pong', () => { client.missed = 0; });
    socket.on('close', () => {
      s.clients.delete(client);
      broadcast(s);
    });
    broadcast(s);
    if (role === 'presenter') send(client, { t: 'notes', slides: (await ctx.decks.readMeta(slug)).slides });
    for (const data of queue.splice(0)) onMessage(client, data);
    return undefined;
  }

  function onMessage(client, data) {
    const s = decks.get(client.slug);
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(client, { t: 'error', code: 'bad-message' });
    }
    if (!msg || typeof msg !== 'object' || !COMMANDS.has(msg.t)) {
      return send(client, { t: 'error', code: 'bad-message' });
    }
    // Re-checked on every command, so a revoked session loses control at once.
    if (client.role !== 'presenter' || !ctx.auth.canPresent(client.req, client.slug)) {
      return send(client, { t: 'error', code: 'forbidden' });
    }
    const changed = apply(s, msg);
    if (changed === null) return send(client, { t: 'error', code: 'bad-message' });
    if (changed) {
      s.rev++;
      broadcast(s);
      persistSoon();
    }
    return undefined;
  }

  const heartbeat = setInterval(() => {
    for (const s of decks.values()) {
      for (const c of s.clients) {
        if (c.missed >= 2) {
          c.socket.terminate();
          continue;
        }
        c.missed++;
        try { c.socket.ping(); } catch { /* closed */ }
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    handleConnection,
    getState(slug) {
      const s = decks.get(slug);
      return s ? snapshot(s) : null;
    },
    notifyNotes(slug, slides) {
      const s = decks.get(slug);
      if (!s) return;
      for (const c of s.clients) {
        if (c.role === 'presenter' && ctx.auth.canPresent(c.req, slug)) send(c, { t: 'notes', slides });
      }
    },
    // The admin changed the deck's default viewer mode: apply it live too.
    setViewerNav(slug, mode) {
      const s = decks.get(slug);
      if (!s || s.viewerNav === mode) return;
      s.viewerNav = mode;
      s.rev++;
      broadcast(s);
    },
    // A deck was replaced or deleted: forget its step count; close sockets if gone.
    resetDeck(slug, { removed = false } = {}) {
      const s = decks.get(slug);
      if (!s) return;
      s.total = 0;
      if (removed) {
        for (const c of s.clients) c.socket.close(4404, 'no-deck');
        decks.delete(slug);
      } else {
        s.rev++;
        broadcast(s);
      }
    },
    async close() {
      clearInterval(heartbeat);
      if (persistTimer) await persistNow();
    },
  };
}

export function registerLive(app, ctx) {
  app.get('/ws/:slug', {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!originMatches(req)) return reply.code(403).send({ error: 'bad-origin' });
      return undefined;
    },
  }, (socket, req) => {
    ctx.live.handleConnection(socket, req).catch((err) => {
      req.log.error(err);
      socket.close(1011, 'error');
    });
  });
}
