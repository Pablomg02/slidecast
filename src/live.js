import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { readJson, writeJsonAtomic } from './store.js';
import { originMatches } from './security.js';
import { VIEWER_NAV } from './decks.js';
import { clientIp, createFailureLimit } from './auth.js';
import { cleanName, cleanNote, slidingLimit } from './rooms.js';
import { createPeople } from './participants.js';

export const MAX_MESSAGE = 4096;
const HEARTBEAT_MS = 25_000;
const MAX_TOTAL = 100_000;
// Connection caps (D10 of 0003): room for a large class behind one NAT
// address, and slots no audience can take from presenters.
const WS_LIMITS = { perIp: 500, total: 1200, presenterReserve: 100 };
// New participants per address and minute, and per-socket flood guard (D9, D14).
const JOIN_LIMIT = { max: 200, windowMs: 60_000 };
const FLOOD = [{ max: 30, ms: 10_000 }];
const GRACE_MS = 120_000;
const JOIN_TIMEOUT_MS = 10_000;

// Close codes the pages act on (see connectLive in public/shell.js).
export const CLOSE = {
  again: 4000, // reload: the room opened or admits people again
  badRole: 4400,
  unauthorized: 4401,
  kicked: 4403,
  noDeck: 4404,
  roomFull: 4409,
  presentersFull: 4410,
  tooMany: 4429,
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Per-deck live state, role-checked commands and broadcasts (D2, D3, D15, D25,
// D26 of 0001), plus the room: participants, hands and limits (0003).
export async function createLive(ctx, { heartbeatMs = HEARTBEAT_MS, graceMs = GRACE_MS } = {}) {
  const livePath = join(ctx.stateDir, 'live.json');
  const persisted = await readJson(livePath, {}).catch(() => ({}));
  const decks = new Map(); // slug → state, see stateOf
  const wsLimits = { ...WS_LIMITS, ...ctx.wsLimits };
  const perIp = new Map(); // address → open connections
  const joins = createFailureLimit({ ...JOIN_LIMIT, ...ctx.joinLimit });
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
      slug,
      index: Number.isInteger(saved.index) && saved.index >= 0 ? saved.index : 0,
      total: 0,
      blank: saved.blank === true,
      viewerNav: meta.viewerNav,
      hands: ctx.rooms.settings(slug).hands,
      rev: 0,
      clients: new Set(), // admitted: presenters, displays, participants and pending joins
      parked: new Set(), // waiting for the room to open or admit people (D4, D11)
      banned: new Set(), // token hashes kicked out until the room closes
      locked: false,
      roomTimer: null,
    };
    s.people = createPeople({ graceMs, onExpire: () => handsChanged(s) });
    decks.set(slug, s);
    return s;
  }

  function snapshot(s) {
    return {
      t: 'state',
      index: s.index,
      total: s.total,
      blank: s.blank,
      viewerNav: s.viewerNav,
      hands: s.hands,
      askNames: ctx.rooms.settings(s.slug).askNames,
      presenting: presenting(s),
      rev: s.rev,
    };
  }

  function send(client, msg) {
    if (client.socket.readyState === 1) client.socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  // State goes to everyone admitted, but only when it changes (D15).
  function broadcast(s) {
    const msg = JSON.stringify(snapshot(s));
    for (const c of s.clients) if (c.kind !== 'pending') send(c, msg);
  }

  const isPresenterKind = (c) => c.kind === 'presenter' || c.kind === 'display';
  const deviceId = (key) => createHash('sha256').update(`device:${key}`).digest('base64url').slice(0, 16);

  // ---- what presenters see (D15) --------------------------------------------

  function roomFor(s) {
    const settings = ctx.rooms.settings(s.slug);
    const devices = new Map();
    for (const c of s.clients) {
      if (c.kind !== 'presenter') continue;
      // The server's own computer can never be removed (D12), owner or not.
      const d = devices.get(c.device) ?? { id: deviceId(c.device), owner: false, local: c.device === 'local', windows: 0 };
      d.owner ||= ctx.auth.canAdmin(c.req);
      d.windows++;
      devices.set(c.device, d);
    }
    const people = s.people.list(Date.now());
    return {
      devices,
      msg: {
        t: 'room',
        open: settings.open,
        locked: s.locked,
        hands: s.hands,
        askNames: settings.askNames,
        maxViewers: settings.maxViewers,
        maxPresenters: settings.maxPresenters,
        viewers: people.filter((p) => p.online).length,
        people,
      },
    };
  }

  function sendRoom(s, only = null) {
    clearTimeout(s.roomTimer);
    s.roomTimer = null;
    const { devices, msg } = roomFor(s);
    const list = [...devices.values()];
    for (const c of only ? [only] : s.clients) {
      if (c.kind !== 'presenter') continue;
      // Names and notes go only to sockets that may still present (signed
      // out, session expired, password changed, removed by the admin).
      if (!ctx.auth.canPresent(c.req, s.slug)) {
        c.socket.close(CLOSE.unauthorized, 'unauthorized');
        continue;
      }
      const mine = devices.get(c.device)?.id;
      send(c, { ...msg, admin: ctx.auth.canAdmin(c.req), presenters: list.map((d) => ({ ...d, you: d.id === mine })) });
    }
  }

  function roomChanged(s) {
    if (s.roomTimer) return;
    s.roomTimer = setTimeout(() => sendRoom(s), s.people.size > 200 ? 1000 : 300);
    s.roomTimer.unref?.();
  }

  // What a participant sees of itself: number, name and hand (D13).
  function you(s, p, extra = {}) {
    const hand = p.hand && { state: p.hand.state, note: p.hand.note, pos: s.people.position(p) };
    const msg = JSON.stringify({ t: 'you', n: p.n, name: p.name, hand, ...extra });
    for (const c of p.sockets) send(c, msg);
  }

  // Queue positions shift for everyone queued behind a change.
  function handsChanged(s, ...changed) {
    const seen = new Set(changed);
    for (const p of changed) you(s, p);
    for (const p of s.people.queue()) if (!seen.has(p)) you(s, p);
    roomChanged(s);
  }

  // The audience is told when nobody with presenter rights is connected.
  const presenting = (s) => [...s.clients].some(isPresenterKind);
  function presenceChanged(s) {
    s.rev++;
    broadcast(s);
  }

  // ---- parking (D4, D11) ------------------------------------------------------

  function park(s, client, reason) {
    clearTimeout(client.joinTimer);
    s.clients.delete(client);
    client.kind = 'parked';
    client.reason = reason;
    s.parked.add(client);
    send(client, { t: 'wait', reason });
  }

  function unpark(s, reason) {
    for (const c of [...s.parked]) {
      if (reason && c.reason !== reason) continue;
      s.parked.delete(c);
      c.socket.close(CLOSE.again, 'again');
    }
  }

  // ---- connections ------------------------------------------------------------

  async function handleConnection(socket, req) {
    const ip = clientIp(req, ctx.trustProxy);
    const role = req.query?.role ?? 'viewer';
    const total = wsLimits.total + (role === 'presenter' ? wsLimits.presenterReserve : 0);
    if (open >= total || (perIp.get(ip) ?? 0) >= wsLimits.perIp) {
      return socket.close(CLOSE.tooMany, 'too-many-connections');
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
    const queue = [];
    let client = null;
    socket.on('message', (data) => {
      if (client) onMessage(client, data);
      else queue.push(data);
    });

    if (!(await ctx.decks.exists(slug))) return socket.close(CLOSE.noDeck, 'no-deck');
    if (role !== 'viewer' && role !== 'presenter') return socket.close(CLOSE.badRole, 'bad-role');
    const canPresent = ctx.auth.canPresent(req, slug);
    const allowed = role === 'presenter' ? canPresent : ctx.auth.canView(req, slug);
    if (!allowed) return socket.close(CLOSE.unauthorized, 'unauthorized');

    const s = await stateOf(slug);
    // The socket may have closed during the awaits; its close event is gone.
    if (socket.readyState !== 1) return undefined;
    // A viewer with presenter rights (the projector) is a display, never a participant (D5).
    const kind = role === 'presenter' ? 'presenter' : canPresent ? 'display' : 'pending';
    client = { socket, kind, req, slug, ip, missed: 0, person: null };
    socket.on('pong', () => { client.missed = 0; });
    socket.on('close', () => {
      clearTimeout(client.joinTimer);
      const last = s.clients.delete(client) && isPresenterKind(client) && !presenting(s);
      s.parked.delete(client);
      if (client.person) s.people.detach(client.person, client);
      if (last) presenceChanged(s);
      roomChanged(s);
    });

    const settings = ctx.rooms.settings(slug);
    if (kind === 'pending') {
      client.flood = slidingLimit(FLOOD);
      if (!settings.open) {
        park(s, client, 'closed');
      } else if (countViewerSockets(s) >= settings.maxViewers) {
        return socket.close(CLOSE.roomFull, 'room-full');
      } else {
        s.clients.add(client);
        client.joinTimer = setTimeout(() => socket.close(CLOSE.badRole, 'no-join'), JOIN_TIMEOUT_MS);
        client.joinTimer.unref?.();
      }
    } else {
      // D8: count devices that control, not windows; the owner always gets
      // in. A display cannot control anything, so it is never refused.
      client.device = ctx.auth.sessionKey(req) ?? 'local';
      client.owner = ctx.auth.canAdmin(req);
      const devices = new Set([...s.clients].filter((c) => c.kind === 'presenter').map((c) => c.device));
      if (kind === 'presenter' && !devices.has(client.device) && devices.size >= settings.maxPresenters && !client.owner) {
        return socket.close(CLOSE.presentersFull, 'presenters-full');
      }
      const first = !presenting(s);
      s.clients.add(client);
      if (first) presenceChanged(s); // its snapshot goes out with everyone's
      else send(client, snapshot(s));
      if (kind === 'presenter') {
        send(client, { t: 'notes', slides: (await ctx.decks.readMeta(slug)).slides });
        sendRoom(s, client);
      }
      roomChanged(s);
    }
    for (const data of queue.splice(0)) onMessage(client, data);
    return undefined;
  }

  function countViewerSockets(s) {
    let n = 0;
    for (const c of s.clients) if (c.kind === 'pending' || c.kind === 'participant') n++;
    return n;
  }

  // ---- participants (D5, D6, D9, D11, D13, D14) -------------------------------

  function joinRoom(s, client, msg) {
    if (client.kind !== 'pending') return send(client, { t: 'error', code: 'bad-message' });
    let token = typeof msg.token === 'string' && TOKEN_RE.test(msg.token) ? msg.token : null;
    let p = token && s.people.byHash(sha256(token));
    if (token && s.banned.has(sha256(token))) return client.socket.close(CLOSE.kicked, 'kicked');
    if (!p) {
      if (s.locked) return park(s, client, 'locked');
      const settings = ctx.rooms.settings(s.slug);
      if (s.people.size >= settings.maxViewers * 2 + 50) return client.socket.close(CLOSE.roomFull, 'room-full');
      if (joins.blockedFor(client.ip)) return client.socket.close(CLOSE.tooMany, 'too-many-joins');
      joins.fail(client.ip);
      token = randomBytes(32).toString('base64url');
      p = s.people.create(sha256(token));
    }
    clearTimeout(client.joinTimer);
    client.kind = 'participant';
    client.person = p;
    s.people.attach(p, client);
    send(client, snapshot(s));
    you(s, p, { token });
    roomChanged(s);
    return undefined;
  }

  function onParticipantMessage(s, client, msg) {
    const now = Date.now();
    if (client.flood.wait(now)) return client.socket.close(1008, 'flood');
    client.flood.hit(now);
    if (client.kind === 'parked') return undefined;
    if (msg.t === 'join') return joinRoom(s, client, msg);
    const p = client.person;
    if (!p) return send(client, { t: 'error', code: msg.t === 'name' || msg.t === 'hand' ? 'bad-message' : 'forbidden' });

    if (msg.t === 'name') {
      if (!ctx.rooms.settings(s.slug).askNames) return send(client, { t: 'error', code: 'names-off' });
      const name = cleanName(msg.name);
      if (name === undefined) return send(client, { t: 'error', code: 'bad-message' });
      const wait = p.renames.wait(now);
      if (wait) return send(client, { t: 'error', code: 'slow-down', wait });
      p.renames.hit(now);
      p.name = name;
      you(s, p);
      return roomChanged(s);
    }
    if (msg.t === 'hand') {
      if (msg.up === false) {
        if (!p.hand) return undefined;
        p.hand = null;
        return handsChanged(s, p);
      }
      if (msg.up !== true) return send(client, { t: 'error', code: 'bad-message' });
      if (!s.hands) return send(client, { t: 'error', code: 'hands-off' });
      if (p.hand) return send(client, { t: 'error', code: 'already-up' });
      const note = cleanNote(msg.note);
      if (note === undefined) return send(client, { t: 'error', code: 'bad-message' });
      const wait = p.raises.wait(now);
      if (wait) return send(client, { t: 'error', code: 'slow-down', wait });
      p.raises.hit(now);
      p.hand = { state: 'raised', note, at: now };
      s.people.stamp(p.hand, now);
      return handsChanged(s, p);
    }
    return send(client, { t: 'error', code: 'forbidden' });
  }

  // ---- presenter commands -----------------------------------------------------

  function clamp(s, i) {
    const max = s.total > 0 ? s.total - 1 : Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.min(max, i));
  }

  // Applies one deck command; returns true if the state changed, null if invalid.
  function apply(s, msg) {
    const before = `${s.index}|${s.total}|${s.blank}|${s.viewerNav}|${s.hands}`;
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
      case 'hands':
        if (typeof msg.on !== 'boolean') return null;
        s.hands = msg.on;
        roomChanged(s);
        break;
      default:
        return null;
    }
    return `${s.index}|${s.total}|${s.blank}|${s.viewerNav}|${s.hands}` !== before;
  }

  const DECK_COMMANDS = new Set(['meta', 'step', 'goto', 'blank', 'nav', 'hands']);
  const ROOM_COMMANDS = new Set(['hand', 'hands-clear', 'lock', 'kick', 'kick-presenter']);

  // Room commands; returns false if invalid.
  function roomCommand(s, client, msg) {
    if (msg.t === 'hand') {
      const p = s.people.byId(msg.id);
      if (!p?.hand) return true; // already resolved by another presenter
      const now = Date.now();
      if (msg.action === 'queue') {
        if (p.hand.state !== 'raised') return true;
        p.hand.state = 'queued';
      } else if (msg.action === 'attend') {
        if (p.hand.state === 'attending') return true;
        p.hand.state = 'attending';
      } else if (msg.action === 'resolve') {
        p.hand = null;
        you(s, p, { resolved: true });
        handsChanged(s);
        return true;
      } else {
        return false;
      }
      s.people.stamp(p.hand, now);
      handsChanged(s, p);
      return true;
    }
    if (msg.t === 'hands-clear') {
      for (const p of s.people.all()) {
        if (!p.hand) continue;
        p.hand = null;
        you(s, p, { resolved: true });
      }
      roomChanged(s);
      return true;
    }
    if (msg.t === 'lock') {
      if (typeof msg.on !== 'boolean') return false;
      s.locked = msg.on;
      if (!s.locked) unpark(s, 'locked');
      roomChanged(s);
      return true;
    }
    if (msg.t === 'kick') {
      const p = s.people.byId(msg.id);
      if (!p) return true;
      s.banned.add(p.hash);
      if (s.banned.size > 10_000) s.banned.delete(s.banned.values().next().value);
      s.people.remove(p);
      for (const c of [...p.sockets]) {
        c.person = null;
        c.socket.close(CLOSE.kicked, 'kicked');
      }
      handsChanged(s);
      return true;
    }
    if (msg.t === 'kick-presenter') {
      if (!ctx.auth.canAdmin(client.req)) {
        send(client, { t: 'error', code: 'forbidden' });
        return true;
      }
      const targets = [...s.clients].filter((c) => isPresenterKind(c) && deviceId(c.device) === msg.id);
      if (!targets.length) return true;
      if (targets.some((c) => ctx.auth.canAdmin(c.req)) || targets[0].device === 'local') {
        send(client, { t: 'error', code: 'cannot-kick-owner' });
        return true;
      }
      const { device } = targets[0];
      ctx.auth.dropPresent(device, s.slug)?.catch(() => {});
      for (const c of targets) c.socket.close(CLOSE.unauthorized, 'unauthorized');
      // The global grant is gone too: that device's windows in other rooms
      // lose what they no longer may see.
      for (const other of decks.values()) {
        if (other === s) continue;
        for (const c of other.clients) {
          if (isPresenterKind(c) && c.device === device && !ctx.auth.canPresent(c.req, other.slug)) {
            c.socket.close(CLOSE.unauthorized, 'unauthorized');
          }
        }
      }
      return true;
    }
    return false;
  }

  function onMessage(client, data) {
    const s = decks.get(client.slug);
    if (!s) return undefined; // the deck was deleted; its sockets are closing
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(client, { t: 'error', code: 'bad-message' });
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      return send(client, { t: 'error', code: 'bad-message' });
    }
    if (client.kind !== 'presenter' && client.kind !== 'display') return onParticipantMessage(s, client, msg);
    if (!DECK_COMMANDS.has(msg.t) && !ROOM_COMMANDS.has(msg.t)) return send(client, { t: 'error', code: 'bad-message' });
    // Re-checked on every command, so a revoked session loses control at once.
    if (client.kind !== 'presenter' || !ctx.auth.canPresent(client.req, client.slug)) {
      return send(client, { t: 'error', code: 'forbidden' });
    }
    if (ROOM_COMMANDS.has(msg.t)) {
      if (!roomCommand(s, client, msg)) send(client, { t: 'error', code: 'bad-message' });
      return undefined;
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
      for (const c of [...s.clients, ...s.parked]) {
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

  // Closing a room parks its participants and forgets them (D4).
  function closeRoom(s) {
    for (const c of [...s.clients]) {
      if (c.kind !== 'participant' && c.kind !== 'pending') continue;
      c.person = null;
      park(s, c, 'closed');
    }
    for (const c of s.parked) {
      if (c.reason === 'closed') continue;
      c.reason = 'closed';
      send(c, { t: 'wait', reason: 'closed' });
    }
    s.people.clear();
    s.banned.clear();
    s.locked = false;
    s.hands = ctx.rooms.settings(s.slug).hands;
    s.rev++;
    broadcast(s);
    sendRoom(s);
  }

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
        if (c.kind === 'presenter' && ctx.auth.canPresent(c.req, slug)) send(c, { t: 'notes', slides });
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
    // The admin changed a room's settings (already saved), `before` being the old ones.
    roomUpdated(slug, before) {
      const s = decks.get(slug);
      if (!s) return;
      const now = ctx.rooms.settings(slug);
      if (before.open && !now.open) return closeRoom(s);
      if (!before.open && now.open) unpark(s);
      if (before.hands !== now.hands) s.hands = now.hands;
      // Names off: everyone becomes anonymous, as if they had never given one (D16).
      if (before.askNames && !now.askNames) {
        for (const p of s.people.all()) {
          if (p.name === null) continue;
          p.name = null;
          you(s, p);
        }
      }
      if (before.hands !== now.hands || before.askNames !== now.askNames) {
        s.rev++;
        broadcast(s);
      }
      return sendRoom(s);
    },
    // Live counts for the admin panel.
    counts(slug) {
      const s = decks.get(slug);
      if (!s) return { viewers: 0, presenters: 0, raised: 0 };
      const { msg, devices } = roomFor(s);
      return { viewers: msg.viewers, presenters: devices.size, raised: msg.people.filter((p) => p.hand).length };
    },
    // A deck was replaced or deleted: forget its step count; close sockets if gone.
    resetDeck(slug, { removed = false } = {}) {
      const s = decks.get(slug);
      if (!s) return;
      s.total = 0;
      if (removed) {
        for (const c of [...s.clients, ...s.parked]) c.socket.close(CLOSE.noDeck, 'no-deck');
        s.people.clear();
        clearTimeout(s.roomTimer);
        decks.delete(slug);
      } else {
        s.rev++;
        broadcast(s);
      }
    },
    async close() {
      clearInterval(heartbeat);
      for (const s of decks.values()) {
        s.people.clear();
        clearTimeout(s.roomTimer);
      }
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
