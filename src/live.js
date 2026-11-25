import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes, createHash } from 'node:crypto';
import { readJson, writeJsonAtomic } from './store.js';
import { originMatches } from './security.js';
import { VIEWER_NAV, layoutOf, pointerOf } from './decks.js';
import { clientIp, createFailureLimit } from './auth.js';
import { cleanName, cleanNote, slidingLimit } from './rooms.js';
import { createPeople } from './participants.js';
import { createPolls, pollOf } from './polls.js';
import { contestOf, rankingOf, csvCell } from './contest.js';
import { deckAuth } from './config.js';
import { shownPassword } from './auth.js';
import { audienceBase, joinLinks, lanAddresses } from './share.js';

export const MAX_MESSAGE = 4096;
const HEARTBEAT_MS = 25_000;
const MAX_TOTAL = 100_000;
// Connection caps (D10 of 0003): room for a large class behind one NAT
// address, and slots no audience can take from presenters.
const WS_LIMITS = { perIp: 500, total: 1200, presenterReserve: 100 };
// New participants per address and minute, and per-socket flood guard (D9, D14).
const JOIN_LIMIT = { max: 200, windowMs: 60_000 };
const FLOOD = [{ max: 30, ms: 10_000 }];
// Shared pointer (D17 of 0010): moves per presenter device (more are dropped),
// and how much a socket may have queued before moves skip it.
const POINTER_LIMIT = [{ max: 30, ms: 1000 }];
const PTR_BUFFER = 16_384;
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

// Column titles of the ranking spreadsheet, in the presenter page's language (D21 of 0009).
const CSV_HEADERS = {
  en: ['Position', 'Name', 'Number', 'Points', 'Right', 'Answered'],
  es: ['Puesto', 'Nombre', 'Número', 'Puntos', 'Aciertos', 'Respondidas'],
};
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Per-deck live state, role-checked commands and broadcasts (D2, D3, D15, D25,
// D26 of 0001), plus the room: participants, hands and limits (0003), and
// its polls (0006).
export async function createLive(ctx, { heartbeatMs = HEARTBEAT_MS, graceMs = GRACE_MS, now = () => performance.now() } = {}) {
  const livePath = join(ctx.stateDir, 'live.json');
  const persisted = await readJson(livePath, {}).catch(() => ({}));
  const decks = new Map(); // slug → state, see stateOf
  const wsLimits = { ...WS_LIMITS, ...ctx.wsLimits };
  const stamp = now; // when an answer arrived, on the monotonic clock (D7 of 0009)
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

  // Layout and pointer changes saved per deck (0010): a deck.json read that
  // started before one may hold the old values, so it must not apply them.
  const screenWrites = new Map();
  const screenGen = (slug) => screenWrites.get(slug) ?? 0;

  async function stateOf(slug) {
    let s = decks.get(slug);
    if (s) return s;
    let meta;
    for (;;) {
      const gen = screenGen(slug);
      meta = await ctx.decks.readMeta(slug);
      s = decks.get(slug); // another connection may have created it meanwhile
      if (s) return s;
      if (screenGen(slug) === gen) break; // else read again: the screens settings changed meanwhile
    }
    const saved = persisted[slug] ?? {};
    s = {
      slug,
      index: Number.isInteger(saved.index) && saved.index >= 0 ? saved.index : 0,
      total: 0,
      blank: saved.blank === true,
      viewerNav: meta.viewerNav,
      contest: contestOf(meta), // contest mode settings (0009)
      layout: layoutOf(meta), // "1920x1080" when frozen, else null (0010)
      pointer: pointerOf(meta), // shared pointer on (0010)
      pointers: new Map(), // presenter device → its colour slot { id, socket, shown, limit }
      hands: ctx.rooms.settings(slug).hands,
      rev: 0,
      clients: new Set(), // admitted: presenters, displays, participants and pending joins
      parked: new Set(), // waiting for the room to open or admit people (D4, D11)
      banned: new Set(), // token hashes kicked out until the room closes
      locked: false,
      roomTimer: null,
      polls: null,
      pollTimer: null,
      countdowns: new Map(), // slide → timer closing its answers (D10 of 0009)
      rankingTimer: null,
      rankingShown: false, // the top 10 on the screens (D20 of 0009)
      shareShown: false, // the join screen on the screens (0011)
      pollQueue: Promise.resolve(), // poll commands, one after the other (D4 of 0006)
      pollPending: 0, // tasks in that queue
      epoch: 0, // +1 each time the room closes
    };
    s.polls = createPolls({ now, contest: () => s.contest });
    // Contest mode keeps a named participant who answered while it is
    // offline, so a locked phone keeps its score (D15 of 0009).
    s.people = createPeople({
      graceMs,
      onExpire: () => handsChanged(s),
      // Also one the presenter asked for another name: it keeps its points (D16).
      keep: (p) => s.contest.on && (p.name !== null || p.renamed === true) && s.polls.hasAnswered(p.id),
    });
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
      contest: s.contest.on,
      layout: s.layout,
      pointer: s.pointer,
      presenting: presenting(s),
      rev: s.rev,
    };
  }

  // The deck's layout changed (frozen or its aspect, 0010): every screen
  // reloads to draw it the new way; one asleep now sees the snapshot's
  // `layout` when it comes back (D7).
  function applyLayout(s, layout) {
    if (s.layout === layout) return;
    s.layout = layout;
    s.rev++;
    for (const c of [...s.clients, ...s.parked]) c.socket.close(CLOSE.again, 'again');
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
      const d = devices.get(c.device) ?? {
        id: deviceId(c.device),
        owner: false,
        local: c.device === 'local',
        windows: 0,
        ptr: s.pointers.get(c.device)?.id ?? null, // its pointer colour (0010)
      };
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

  // ---- polls (0006) -------------------------------------------------------------

  // Every run, counts only, to presenters (D6, D7 of 0006); the shown one to
  // displays, its counts only once public (D1, D4 of 0008).
  function sendPolls(s, only = null) {
    if (!only) {
      clearTimeout(s.pollTimer);
      s.pollTimer = null;
    }
    let forPresenters = null;
    let forDisplays = null;
    for (const c of only ? [only] : s.clients) {
      if (!isPresenterKind(c)) continue;
      // Live counts only to windows that may still present: a projector
      // whose session ended reloads as a participant (D7).
      if (!ctx.auth.canPresent(c.req, s.slug)) {
        c.socket.close(CLOSE.unauthorized, 'unauthorized');
        continue;
      }
      if (c.kind === 'presenter') send(c, forPresenters ??= JSON.stringify(s.polls.forPresenters()));
      else send(c, forDisplays ??= JSON.stringify(s.polls.forDisplays()));
    }
  }

  // While answers arrive: at most every 300 ms (1 s above 200 participants).
  // Participants follow too while the results of an open poll are public:
  // the same small message, built once, for all of them.
  function pollsSoon(s) {
    if (s.pollTimer) return;
    s.pollTimer = setTimeout(() => {
      sendPolls(s);
      const counts = s.polls.liveCounts();
      if (!counts) return;
      const msg = JSON.stringify(counts);
      for (const p of s.people.all()) for (const c of p.sockets) send(c, msg);
    }, s.people.size > 200 ? 1000 : 300);
    s.pollTimer.unref?.();
  }

  // The shown poll and its own answer, to each window of a participant;
  // `ack` when it answers that participant's own answer.
  function sendPoll(s, p, ack = false) {
    const msg = JSON.stringify(ack ? { ...s.polls.forParticipant(p.id), ack: true } : s.polls.forParticipant(p.id));
    for (const c of p.sockets) send(c, msg);
  }

  // A poll was shown, hidden, opened, closed, its results shown or hidden,
  // or reset: everyone at once.
  function pollChanged(s) {
    sendPolls(s);
    for (const p of s.people.all()) if (p.sockets.size) sendPoll(s, p);
    syncCountdowns(s);
    rankingSoon(s);
  }

  // ---- join screen (0011) --------------------------------------------------------

  // What one screen shows to let people in (D2, D3, D5, D7): the address
  // worked out for that screen, and the viewer password only while shown
  // and only if the room shows it. `lan` is computed once per broadcast.
  function shareFor(s, c, lan) {
    const room = ctx.rooms.settings(s.slug);
    const needsPassword = Boolean(deckAuth(ctx.config, s.slug).viewerHash);
    const password = room.showPassword ? shownPassword(ctx.config, s.slug) : null;
    const base = audienceBase({
      configured: ctx.config.audienceUrl, origin: c.req.headers?.origin, listen: ctx.listenAddress?.(), lan,
    });
    return {
      t: 'share',
      shown: s.shareShown,
      ...joinLinks(base, s.slug),
      protected: needsPassword,
      password: s.shareShown ? password : null,
      // For the presenter: the room shows it, but the server has no copy yet.
      passwordMissing: room.showPassword && needsPassword && !password,
    };
  }

  // Only to windows that may still present; the audience never gets it (D7).
  function sendShare(s, only = null) {
    let addresses = null;
    const lan = () => (addresses ??= lanAddresses());
    for (const c of only ? [only] : s.clients) {
      if (!isPresenterKind(c)) continue;
      if (!ctx.auth.canPresent(c.req, s.slug)) {
        c.socket.close(CLOSE.unauthorized, 'unauthorized');
        continue;
      }
      send(c, shareFor(s, c, lan));
    }
  }

  // The join screen leaves the screens: the slides moved, or a poll, its
  // results or the ranking went on them (D8).
  function shareOff(s) {
    if (!s.shareShown) return;
    s.shareShown = false;
    sendShare(s);
  }

  // ---- contest mode (0009) ------------------------------------------------------

  // One timer per open run with a countdown; it closes the answers through
  // the poll queue, so votes received in time but queued behind a command
  // still count (D10).
  function syncCountdowns(s) {
    for (const timer of s.countdowns.values()) clearTimeout(timer);
    s.countdowns.clear();
    for (const [slide, ms] of s.polls.deadlines()) {
      const timer = setTimeout(() => {
        s.countdowns.delete(slide);
        pollTask(s, () => {
          if (decks.get(s.slug) !== s) return;
          if (s.polls.expire(slide)) pollChanged(s);
          else syncCountdowns(s); // woke up early: wait again
        });
      }, ms);
      timer.unref?.();
      s.countdowns.set(slide, timer);
    }
  }

  function clearContestTimers(s) {
    for (const timer of s.countdowns.values()) clearTimeout(timer);
    s.countdowns.clear();
    clearTimeout(s.rankingTimer);
    s.rankingTimer = null;
  }

  const onlineNamed = (s) => [...s.people.all()].filter((p) => p.sockets.size && p.name !== null).map((p) => p.id);

  // Everyone online with a name has answered the shown graded poll: its
  // answers close by themselves, results secret (D11).
  function autoClose(s) {
    if (!s.contest.on) return;
    pollTask(s, () => {
      if (decks.get(s.slug) !== s || !s.contest.on) return;
      if (s.polls.allAnswered(onlineNamed(s)) && s.polls.closeShown()) pollChanged(s);
    });
  }

  // The ranking as every kind of client sees it (D17, D19).
  function rankingFor(s) {
    if (!s.contest.on) return { runs: [], rows: [] };
    const { runs, voters } = s.polls.scores();
    const present = voters.filter((v) => s.people.byId(v.voter));
    const rows = rankingOf(present, (id) => s.people.byId(id));
    return { runs, rows };
  }

  const shownName = (r) => r.name ?? `#${r.n}`;

  function sendRanking(s, only = null) {
    if (!only) {
      clearTimeout(s.rankingTimer);
      s.rankingTimer = null;
    }
    const { runs, rows } = rankingFor(s);
    const forPresenters = JSON.stringify({
      t: 'ranking',
      on: s.contest.on,
      config: s.contest, // for the presenter's chips of polls not launched yet
      shown: s.rankingShown,
      counted: runs.length,
      unscored: s.contest.on ? s.polls.unscored() : [],
      rows: rows.map((r) => ({
        id: r.voter, n: r.n, name: r.name, online: Boolean(s.people.byId(r.voter)?.sockets.size),
        points: r.points, pos: r.pos, answered: r.answered, right: r.right,
      })),
    });
    const forDisplays = JSON.stringify({
      t: 'ranking',
      shown: s.rankingShown,
      total: rows.length,
      rows: s.rankingShown ? rows.slice(0, 10).map((r) => ({ pos: r.pos, name: shownName(r), points: r.points })) : [],
    });
    for (const c of only ? [only] : s.clients) {
      if (c.kind === 'presenter' && ctx.auth.canPresent(c.req, s.slug)) send(c, forPresenters);
      else if (c.kind === 'display') send(c, forDisplays);
    }
    if (only) return;
    // Each participant its own points and place, only when they changed.
    const last = runs.reduce((a, r) => (!a || r.scoredSeq > a.scoredSeq ? r : a), null);
    const byVoter = new Map(rows.map((r) => [r.voter, r]));
    for (const p of s.people.all()) if (p.sockets.size) sendScore(s, p, false, { rows, byVoter, last });
  }

  function scoreOf(s, p, { rows, byVoter, last }) {
    const row = byVoter.get(p.id);
    return {
      t: 'score',
      on: s.contest.on,
      points: row?.points ?? 0,
      pos: row?.pos ?? null,
      of: rows.length,
      last: row && last ? { id: last.id, ...row.per[last.id] } : null,
    };
  }

  // `force`: on joining, even if nothing changed since the last one.
  function sendScore(s, p, force = false, ranking = null) {
    let r = ranking;
    if (!r) {
      const { runs, rows } = rankingFor(s);
      r = { rows, byVoter: new Map(rows.map((x) => [x.voter, x])), last: runs.reduce((a, x) => (!a || x.scoredSeq > a.scoredSeq ? x : a), null) };
    }
    const msg = JSON.stringify(scoreOf(s, p, r));
    if (!force && p.lastScore === msg) return;
    p.lastScore = msg;
    for (const c of p.sockets) send(c, msg);
  }

  // At most every 300 ms (1 s above 200 participants), computed once.
  function rankingSoon(s) {
    if (s.rankingTimer || !s.contest.on) return;
    s.rankingTimer = setTimeout(() => sendRanking(s), s.people.size > 200 ? 1000 : 300);
    s.rankingTimer.unref?.();
  }

  const CONTEST_ACTIONS = new Set(['show-ranking', 'hide-ranking', 'restart', 'rename']);

  // {t: 'contest', action} from presenters (D16, D20), in the poll queue.
  function contestCommand(s, client, msg) {
    if (!CONTEST_ACTIONS.has(msg.action)) return false;
    if (msg.action === 'rename' && typeof msg.id !== 'string') return false;
    if (!s.contest.on) {
      send(client, { t: 'error', code: 'contest-off' });
      return true;
    }
    pollTask(s, () => {
      if (decks.get(s.slug) !== s || !s.contest.on) return;
      if (msg.action === 'show-ranking' || msg.action === 'hide-ranking') {
        const on = msg.action === 'show-ranking';
        if (s.rankingShown === on) return;
        s.rankingShown = on;
        // One overlay at a time on the screens.
        if (on && s.polls.hide()) pollChanged(s);
        if (on) shareOff(s);
        sendRanking(s);
      } else if (msg.action === 'restart') {
        s.polls.clear();
        s.rankingShown = false;
        pollChanged(s);
        sendRanking(s);
      } else {
        const p = s.people.byId(msg.id);
        if (!p || p.name === null) return;
        p.name = null;
        p.renamed = true; // asked again on every join until it picks one
        you(s, p, { renameAsked: true });
        roomChanged(s);
        rankingSoon(s);
      }
    });
    return true;
  }

  // The ranking leaves the screens (a poll was shown, the slides moved).
  function rankingOff(s) {
    if (!s.rankingShown) return;
    s.rankingShown = false;
    sendRanking(s);
  }

  // The deck's contest settings changed (D9, D13, D15).
  function applyContest(s, contest) {
    const before = s.contest;
    s.contest = contest;
    s.polls.contestChanged();
    if (before.on && !contest.on) {
      s.rankingShown = false;
      if (!ctx.rooms.settings(s.slug).askNames) {
        for (const p of s.people.all()) {
          if (p.name === null) continue;
          p.name = null;
          you(s, p);
        }
        roomChanged(s);
      }
      s.people.expireOffline();
    } else if (!before.on && contest.on) {
      s.people.keepNow();
    }
    s.rev++;
    broadcast(s);
    pollChanged(s);
    sendRanking(s);
  }

  const POLL_ACTIONS = new Set(['show', 'hide', 'open', 'close', 'reveal', 'conceal', 'reset']);
  const validSlideId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\0-\x1f]/.test(v);

  // {t: 'poll', action, slide}, and `results` (whether they go public) on
  // close; false if invalid. The text comes from
  // deck.json, never from the message (D2), so show reads it first;
  // the queue keeps a room's commands in the order they came (D4).
  function pollCommand(s, client, msg) {
    if (!POLL_ACTIONS.has(msg.action)) return false;
    if (msg.action !== 'hide' && !validSlideId(msg.slide)) return false;
    if (msg.results !== undefined && (msg.action !== 'close' || typeof msg.results !== 'boolean')) return false;
    pollTask(s, () => runPollCommand(s, client, msg));
    return true;
  }

  function pollTask(s, fn) {
    s.pollPending++;
    s.pollQueue = s.pollQueue.then(fn).catch(() => {}).finally(() => { s.pollPending--; });
  }

  async function runPollCommand(s, client, msg) {
    const { action, slide } = msg;
    let changed;
    if (action === 'hide') {
      changed = s.polls.hide();
    } else if (action === 'reset') {
      changed = s.polls.reset(slide);
    } else if (action === 'open' || action === 'close') {
      changed = s.polls.setOpen(slide, action === 'open', msg.results === true);
      if (changed === 'time-up') {
        send(client, { t: 'error', code: 'time-up' });
        return;
      }
      if (changed && msg.results === true) shareOff(s);
    } else if (action === 'reveal' || action === 'conceal') {
      changed = s.polls.setRevealed(slide, action === 'reveal');
      if (changed && action === 'reveal') shareOff(s);
    } else {
      const epoch = s.epoch;
      const meta = await ctx.decks.readMeta(s.slug).catch(() => null);
      // The deck was deleted, or the room closed (forgetting every poll), meanwhile.
      if (decks.get(s.slug) !== s || s.epoch !== epoch) return;
      const def = meta && Object.hasOwn(meta.slides, slide) ? pollOf(meta.slides[slide]) : null;
      const had = s.polls.get(slide);
      changed = s.polls.show(slide, def);
      if (!changed) {
        send(client, { t: 'error', code: 'no-poll' });
        if (had && !s.polls.get(slide)) sendPolls(s); // an unanswered run whose poll is gone
        return;
      }
      rankingOff(s);
      shareOff(s);
    }
    if (changed) pollChanged(s);
  }

  // A participant's answer. While poll commands wait in the queue (a show
  // reading deck.json), it waits behind them, so an answer sent after "close
  // answers" is never counted.
  // `at`: when the server received it (D7 of 0009).
  function vote(s, p, client, msg, at) {
    if (s.people.byId(p.id) !== p) return; // removed meanwhile
    // Only a first answer can complete "everyone answered": a changed one,
    // after answers were reopened, must not close them on the others.
    const first = !s.polls.shown?.ballots?.has(p.id);
    const err = s.polls.vote(p.id, msg.id, msg.choice, at);
    sendPoll(s, p, true);
    if (err) {
      send(client, { t: 'error', code: err, about: 'poll' });
      return;
    }
    pollsSoon(s);
    if (first) autoClose(s);
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
      if (client.kind === 'presenter') pointerLeft(s, client);
      roomChanged(s);
      if (client.person && s.contest.on) {
        autoClose(s); // the one still to answer left
        rankingSoon(s);
      }
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
      sendPolls(s, client);
      sendRanking(s, client);
      sendShare(s, client);
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
    you(s, p, { token, ...(p.renamed ? { renameAsked: true } : {}) });
    send(client, s.polls.forParticipant(p.id));
    // Its score comes with the next ranking, computed once for everyone who
    // joins meanwhile (a whole class reconnecting at once), which also marks
    // it online for presenters.
    if (s.contest.on) {
      p.lastScore = null;
      rankingSoon(s);
    }
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
      const contest = s.contest.on;
      if (!contest && !ctx.rooms.settings(s.slug).askNames) return send(client, { t: 'error', code: 'names-off' });
      const name = cleanName(msg.name);
      if (name === undefined) return send(client, { t: 'error', code: 'bad-message' });
      // Contest mode: a name is needed, and nobody else in the room has it (D13, D14 of 0009).
      if (contest && name === null) return send(client, { t: 'error', code: 'name-needed' });
      if (contest && name !== p.name) {
        const key = name.toLocaleLowerCase('und');
        const other = [...s.people.all()].find((o) => o !== p && o.name !== null && o.name.toLocaleLowerCase('und') === key);
        if (other) return send(client, { t: 'error', code: 'name-taken', offline: other.sockets.size === 0 });
      }
      const wait = p.renames.wait(now);
      if (wait) return send(client, { t: 'error', code: 'slow-down', wait });
      p.renames.hit(now);
      p.name = name;
      if (name !== null) p.renamed = false;
      you(s, p);
      if (contest) rankingSoon(s);
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
    if (msg.t === 'vote') {
      // Errors about answers say so (`about`), so the page never takes them
      // for its hand's. The poll as it is goes back with them.
      const wait = p.votes.wait(now);
      if (wait) return send(client, { t: 'error', code: 'slow-down', wait, about: 'poll' });
      p.votes.hit(now);
      // In contest mode answers come with a name (D13 of 0009).
      if (s.contest.on && p.name === null) return send(client, { t: 'error', code: 'name-needed', about: 'poll' });
      const at = stamp();
      if (s.pollPending) pollTask(s, () => vote(s, p, client, msg, at));
      else vote(s, p, client, msg, at);
      return undefined;
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
  const ROOM_COMMANDS = new Set(['hand', 'hands-clear', 'lock', 'kick', 'kick-presenter', 'poll', 'contest', 'ptr', 'share']);

  // ---- shared pointer (0010) ---------------------------------------------------

  // To every screen of the deck but the sender's socket, never stored. Moves
  // skip sockets that are behind; hiding a dot always goes out (D17, D18).
  function relayPointer(s, from, msg, isMove = false) {
    const data = JSON.stringify(msg);
    for (const c of s.clients) {
      if (c === from || c.kind === 'pending') continue;
      if (isMove && c.socket.bufferedAmount > PTR_BUFFER) continue;
      send(c, data);
    }
  }

  // The lowest colour slot no device holds.
  function freeSlot(s) {
    const used = new Set([...s.pointers.values()].map((p) => p.id));
    let id = 0;
    while (used.has(id)) id++;
    return id;
  }

  const ptrCoord = (v) => Number.isInteger(v) && v >= 0 && v <= 10_000;

  // {t:'ptr', on} / {x, y} / {off}; returns false if invalid.
  function pointerCommand(s, client, msg) {
    const move = ptrCoord(msg.x) && ptrCoord(msg.y);
    if (msg.on !== true && msg.off !== true && !move) return false;
    if (!s.pointer) {
      send(client, { t: 'error', code: 'pointer-off' });
      return true;
    }
    if (!s.clients.has(client)) return true; // queued before admission, gone since
    let slot = s.pointers.get(client.device);
    if (msg.off === true) {
      if (slot?.socket === client && slot.shown) {
        slot.shown = false;
        relayPointer(s, client, { t: 'ptr', id: slot.id, off: true });
      }
      return true;
    }
    if (!slot) {
      slot = { id: freeSlot(s), socket: client, shown: false, limit: slidingLimit(POINTER_LIMIT) };
      s.pointers.set(client.device, slot);
      roomChanged(s); // presenters learn their colour
    }
    if (!move || s.blank) return true;
    const now = Date.now();
    if (slot.limit.wait(now)) return true; // too many: dropped, the next one goes
    slot.limit.hit(now);
    slot.socket = client; // the device's window that moves the dot now
    slot.shown = true;
    relayPointer(s, client, { t: 'ptr', id: slot.id, x: msg.x, y: msg.y }, true);
    return true;
  }

  // A presenter window left: its dot goes, and the slot once the device has no window.
  function pointerLeft(s, client) {
    const slot = s.pointers.get(client.device);
    if (!slot) return;
    if (slot.socket === client && slot.shown) {
      slot.shown = false;
      relayPointer(s, client, { t: 'ptr', id: slot.id, off: true });
    }
    const more = [...s.clients].some((c) => c.kind === 'presenter' && c.device === client.device);
    if (!more) s.pointers.delete(client.device);
  }

  function applyPointer(s, on) {
    if (s.pointer === on) return;
    s.pointer = on;
    s.rev++;
    broadcast(s);
    if (!on) clearPointers(s);
  }

  // Every dot hidden, colours kept (a deck update, D16 of 0010).
  function hidePointers(s) {
    let shown = false;
    for (const slot of s.pointers.values()) {
      shown ||= slot.shown;
      slot.shown = false;
    }
    if (shown) relayPointer(s, null, { t: 'ptr', clear: true });
  }

  function clearPointers(s) {
    const had = s.pointers.size > 0;
    s.pointers.clear();
    relayPointer(s, null, { t: 'ptr', clear: true });
    if (had) roomChanged(s);
  }

  // Room commands; returns false if invalid.
  function roomCommand(s, client, msg) {
    if (msg.t === 'ptr') return pointerCommand(s, client, msg);
    if (msg.t === 'poll') return pollCommand(s, client, msg);
    if (msg.t === 'contest') return contestCommand(s, client, msg);
    // {t: 'share', on}: the join screen on or off the screens (D1 of 0011).
    if (msg.t === 'share') {
      if (typeof msg.on !== 'boolean') return false;
      if (s.shareShown === msg.on) return true;
      s.shareShown = msg.on;
      sendShare(s);
      return true;
    }
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
      if (s.polls.forget(p.id)) {
        // Public results of closed answers: participants see them, and they
        // just changed (open ones follow the counts anyway).
        if (s.polls.shown?.revealed && !s.polls.shown.open) pollChanged(s);
        else pollsSoon(s);
      }
      if (s.contest.on) {
        autoClose(s);
        rankingSoon(s);
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
    // A page coming back from the background asks whether its socket still
    // works (connectLive): anyone may, even parked; audience pings count as
    // messages for the flood guard.
    if (msg.t === 'ping') {
      if (client.flood) {
        const now = Date.now();
        if (client.flood.wait(now)) return client.socket.close(1008, 'flood');
        client.flood.hit(now);
      }
      return send(client, { t: 'pong' });
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
    const index = s.index;
    const wasBlank = s.blank;
    const changed = apply(s, msg);
    if (changed === null) return send(client, { t: 'error', code: 'bad-message' });
    if (s.index !== index) {
      rankingOff(s); // the slides moved on (D20 of 0009)
      shareOff(s); // (D8 of 0011)
    }
    // Dots hide on a new step or a blank screen; the pages do it on `state` (D19 of 0010).
    if (s.index !== index || (s.blank && !wasBlank)) for (const slot of s.pointers.values()) slot.shown = false;
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
    s.polls.clear();
    clearContestTimers(s);
    s.rankingShown = false;
    s.shareShown = false;
    s.epoch++;
    s.rev++;
    broadcast(s);
    sendRoom(s);
    sendPolls(s);
    sendRanking(s);
    sendShare(s);
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
      // A poll edited before anyone answered it shows its new text (D2 of 0006).
      if (s.polls.refresh(slides)) pollChanged(s);
    },
    // The admin changed the deck's default viewer mode: apply it live too.
    setViewerNav(slug, mode) {
      const s = decks.get(slug);
      if (!s || s.viewerNav === mode) return;
      s.viewerNav = mode;
      s.rev++;
      broadcast(s);
    },
    // The deck's contest settings changed (already saved): apply them live.
    setContest(slug, contest) {
      const s = decks.get(slug);
      if (!s || JSON.stringify(s.contest) === JSON.stringify(contest)) return;
      applyContest(s, contest);
    },
    // The live layout key (0010); undefined when the deck has no live state.
    layoutOf(slug) {
      return decks.get(slug)?.layout;
    },
    // The deck's layout changed (already saved): open screens reload.
    setLayout(slug, layout) {
      screenWrites.set(slug, screenGen(slug) + 1);
      const s = decks.get(slug);
      if (s) applyLayout(s, layout);
    },
    // The shared pointer was turned on or off (already saved, 0010).
    setPointer(slug, on) {
      screenWrites.set(slug, screenGen(slug) + 1);
      const s = decks.get(slug);
      if (s) applyPointer(s, on);
    },
    // The ranking as a spreadsheet (D21 of 0009); null without a room.
    contestCsv(slug, lang = 'en') {
      const s = decks.get(slug);
      if (!s) return null;
      const { runs, rows } = rankingFor(s);
      const head = CSV_HEADERS[lang] ?? CSV_HEADERS.en;
      const lines = [[...head, ...runs.map((r) => r.question)]];
      for (const r of rows) {
        lines.push([r.pos, shownName(r), r.n, r.points, r.right, r.answered, ...runs.map((run) => r.per[run.id]?.points ?? 0)]);
      }
      return `\ufeff${lines.map((l) => l.map(csvCell).join(';')).join('\r\n')}\r\n`;
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
      if (before.askNames && !now.askNames && !s.contest.on) {
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
      sendShare(s); // whether it shows the password (D5 of 0011)
      return sendRoom(s);
    },
    // The audience address or a viewer password changed (0011): the screens
    // of that deck, or of every deck, show the new one.
    shareChanged(slug = null) {
      for (const s of decks.values()) if (slug === null || s.slug === slug) sendShare(s);
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
        clearTimeout(s.pollTimer);
        clearContestTimers(s);
        decks.delete(slug);
      } else {
        s.rev++;
        broadcast(s);
        hidePointers(s); // the dots pointed at the old version (0010)
        // A new version may bring other contest settings (D22 of 0009).
        const gen = screenGen(slug);
        ctx.decks.readMeta(slug).then((meta) => {
          if (decks.get(slug) !== s) return;
          const contest = contestOf(meta);
          if (JSON.stringify(s.contest) !== JSON.stringify(contest)) applyContest(s, contest);
          // Another layout or pointer too (0010), unless the admin saved one since.
          if (screenGen(slug) !== gen) return;
          applyLayout(s, layoutOf(meta));
          applyPointer(s, pointerOf(meta));
        }).catch(() => {});
      }
    },
    async close() {
      clearInterval(heartbeat);
      for (const s of decks.values()) {
        s.people.clear();
        clearTimeout(s.roomTimer);
        clearTimeout(s.pollTimer);
        clearContestTimers(s);
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
