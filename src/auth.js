import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';
import { deckAuth, saveConfig } from './config.js';
import { isValidSlug } from './decks.js';

// ---- passwords (D9) --------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((res, rej) => {
    scrypt(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? rej(err) : res(key)));
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(String(password), salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const want = Buffer.from(parts[5], 'base64');
  if (!want.length) return false;
  const got = await scryptAsync(password, salt, want.length, { N, r, p });
  return timingSafeEqual(got, want);
}

export function checkPasswordInput(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return 'password-too-short';
  if (password.length > MAX_PASSWORD) return 'password-too-long';
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) return 'password-too-weak';
  return null;
}

// ---- request facts ---------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];

function socketAddress(req) {
  return (req.raw ?? req).socket?.remoteAddress ?? '';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// True when the Host header names this machine by a loopback name. Any other
// name reaching a loopback socket may be a DNS-rebound attacker's domain.
function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  return LOOPBACK_HOSTS.has(host.toLowerCase().replace(/:\d+$/, ''));
}

// D10: loopback alone is not enough, because cloudflared also connects from
// localhost; a request that went through any proxy carries one of these headers.
export function isLocalDirect(req) {
  if (!LOOPBACK.has(socketAddress(req)) || !isLoopbackHost(req.headers.host)) return false;
  return PROXY_HEADERS.every((h) => req.headers[h] === undefined);
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return socketAddress(req);
}

export function isHttps(req, trustProxy) {
  if ((req.raw ?? req).socket?.encrypted) return true;
  if (!trustProxy) return false;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

// ---- sessions (D11) --------------------------------------------------------

export const COOKIE = 'sc_session';
const IDLE_MS = 7 * 24 * 3600 * 1000;
const ABSOLUTE_MS = 30 * 24 * 3600 * 1000;
const TOUCH_MS = 60 * 1000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function isExpired(s, now) {
  return now - s.lastSeen > IDLE_MS || now - s.created > ABSOLUTE_MS;
}

function isEmpty(s) {
  return !s.admin && !s.present.length && !s.view.length;
}

// Removes the scope a changed password protected from every session.
// kind: "admin" | "presenter" (global) | "deckPresenter" | "deckViewer".
export function revokeScope(sessions, config, kind, slug) {
  for (const [id, s] of Object.entries(sessions)) {
    if (kind === 'admin') s.admin = false;
    if (kind === 'presenter') {
      // Slugs granted through the global password go too.
      s.present = s.present.filter((x) => x !== '*' && Boolean(deckAuth(config, x).presenterHash));
    }
    if (kind === 'deckPresenter') s.present = s.present.filter((x) => x !== slug);
    if (kind === 'deckViewer') s.view = s.view.filter((x) => x !== slug);
    if (isEmpty(s)) delete sessions[id];
  }
}

// Stores (or clears, with hash null) the hash for a password kind:
// "admin" | "presenter" | "deckPresenter" | "deckViewer".
export function applyPasswordHash(config, kind, slug, hash) {
  if (kind === 'admin') config.adminHash = hash;
  else if (kind === 'presenter') config.presenterHash = hash;
  else {
    const d = { presenterHash: null, viewerHash: null, ...config.decks[slug] };
    if (kind === 'deckPresenter') d.presenterHash = hash;
    else d.viewerHash = hash;
    if (d.presenterHash || d.viewerHash) config.decks[slug] = d;
    else delete config.decks[slug];
  }
}

export function hashFields(config) {
  const out = { admin: config.adminHash, presenter: config.presenterHash };
  for (const [slug, d] of Object.entries(config.decks)) {
    out[`deckPresenter:${slug}`] = d.presenterHash ?? null;
    out[`deckViewer:${slug}`] = d.viewerHash ?? null;
  }
  return out;
}

export async function createAuth(ctx) {
  const path = join(ctx.stateDir, 'sessions.json');
  const sessions = {};
  const stored = await readJson(path, {}).catch(() => ({}));
  const now = Date.now();
  for (const [id, s] of Object.entries(stored)) {
    if (s && /^[0-9a-f]{64}$/.test(id) && !isExpired(s, now)) {
      sessions[id] = {
        admin: s.admin === true,
        present: Array.isArray(s.present) ? s.present : [],
        view: Array.isArray(s.view) ? s.view : [],
        created: s.created,
        lastSeen: s.lastSeen,
      };
    }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    return writeJsonAtomic(path, sessions);
  }
  function saveSoon() {
    if (!saveTimer) saveTimer = setTimeout(() => save().catch(() => {}), 2000);
  }
  function sweep() {
    const t = Date.now();
    let changed = false;
    for (const [id, s] of Object.entries(sessions)) {
      if (isExpired(s, t)) {
        delete sessions[id];
        changed = true;
      }
    }
    if (changed) saveSoon();
  }
  const sweeper = setInterval(sweep, 3600 * 1000);
  sweeper.unref();

  function getSession(req) {
    const raw = req.cookies?.[COOKIE];
    if (typeof raw !== 'string' || raw.length > 100) return null;
    const s = sessions[sha256(raw)];
    if (!s) return null;
    const t = Date.now();
    if (isExpired(s, t)) {
      delete sessions[sha256(raw)];
      saveSoon();
      return null;
    }
    if (t - s.lastSeen > TOUCH_MS) {
      s.lastSeen = t;
      saveSoon();
    }
    return s;
  }

  const { config } = ctx;

  // Stable key of the session a request carries (its stored hash), or null.
  function sessionKey(req) {
    const raw = req.cookies?.[COOKIE];
    return getSession(req) ? sha256(raw) : null;
  }

  // Removes a deck (and the global grant) from one session's presenter
  // rights: the admin removed that presenter from the room (D12 of 0003).
  function dropPresent(key, slug) {
    const s = sessions[key];
    if (!s) return undefined;
    s.present = s.present.filter((x) => x !== slug && x !== '*');
    if (isEmpty(s)) delete sessions[key];
    return save();
  }

  function canAdmin(req) {
    if (getSession(req)?.admin) return true;
    return !config.adminHash && isLocalDirect(req);
  }

  function presenterHashFor(slug) {
    return deckAuth(config, slug).presenterHash ?? config.presenterHash;
  }

  function canPresent(req, slug) {
    if (canAdmin(req)) return true;
    const s = getSession(req);
    const deckHash = deckAuth(config, slug).presenterHash;
    if (s?.present.includes(slug)) return true;
    // "*" comes from the global password, which a deck's own password overrides.
    if (s?.present.includes('*') && !deckHash) return true;
    return !presenterHashFor(slug) && isLocalDirect(req);
  }

  function canView(req, slug) {
    if (!deckAuth(config, slug).viewerHash) return true;
    if (canPresent(req, slug)) return true;
    return Boolean(getSession(req)?.view.includes(slug));
  }

  // Issues a fresh session id holding the old scopes plus the new grant
  // (a new id on every login prevents session fixation).
  function grant(req, reply, { admin = false, present = [], view = [] }) {
    const oldRaw = req.cookies?.[COOKIE];
    const old = typeof oldRaw === 'string' ? sessions[sha256(oldRaw)] : null;
    if (old) delete sessions[sha256(oldRaw)];
    const t = Date.now();
    const s = {
      admin: admin || Boolean(old?.admin),
      present: [...new Set([...(old?.present ?? []), ...present])],
      view: [...new Set([...(old?.view ?? []), ...view])],
      created: t,
      lastSeen: t,
    };
    const raw = randomBytes(32).toString('base64url');
    sessions[sha256(raw)] = s;
    reply.setCookie(COOKIE, raw, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: isHttps(req, ctx.trustProxy),
      maxAge: ABSOLUTE_MS / 1000,
    });
    return save();
  }

  function logout(req, reply) {
    const raw = req.cookies?.[COOKIE];
    if (typeof raw === 'string') delete sessions[sha256(raw)];
    reply.clearCookie(COOKIE, { path: '/' });
    return save();
  }

  function revoke(kind, slug) {
    revokeScope(sessions, config, kind, slug);
    return save();
  }

  // Sets or clears a password, saves the config and revokes the sessions that
  // held the scope it protects.
  async function setPassword(kind, slug, password) {
    applyPasswordHash(config, kind, slug, password === null ? null : await hashPassword(password));
    lastHashes = hashFields(config);
    await saveConfig(ctx.stateDir, config);
    await revoke(kind, slug);
  }

  // The CLI may change config.json while the server runs: reload it, and
  // revoke the scopes whose password changed.
  let lastHashes = hashFields(config);
  function onConfigFileChanged(fresh) {
    const before = lastHashes;
    Object.assign(config, fresh);
    lastHashes = hashFields(config);
    for (const key of new Set([...Object.keys(before), ...Object.keys(lastHashes)])) {
      if ((before[key] ?? null) !== (lastHashes[key] ?? null)) {
        const [kind, slug] = key.split(':');
        revokeScope(sessions, config, kind, slug);
      }
    }
    return save();
  }

  function close() {
    clearInterval(sweeper);
    if (saveTimer) return save();
    return undefined;
  }

  return {
    sessions,
    getSession,
    sessionKey,
    dropPresent,
    canAdmin,
    canPresent,
    canView,
    grant,
    logout,
    revoke,
    setPassword,
    presenterHashFor,
    onConfigFileChanged,
    close,
  };
}

// ---- routes ----------------------------------------------------------------

const SCOPES = new Set(['admin', 'presenter', 'viewer']);

const HOUR = 3_600_000;

// Failed logins per key in a fixed one-hour window (D3 of 0002). Only failures
// count, so people who sign in often are never locked out.
export function createFailureLimit({ max, windowMs = HOUR, now = Date.now } = {}) {
  const entries = new Map(); // key → {count, resetAt}
  function current(key) {
    const e = entries.get(key);
    if (e && e.resetAt > now()) return e;
    entries.delete(key);
    return null;
  }
  return {
    // Seconds until the key may try again, or 0 if it may try now.
    blockedFor(key) {
      const e = current(key);
      return e && e.count >= max ? Math.ceil((e.resetAt - now()) / 1000) : 0;
    },
    // Records a failure; returns true when this one reached the limit.
    fail(key) {
      const e = current(key) ?? { count: 0, resetAt: now() + windowMs };
      e.count++;
      entries.set(key, e);
      if (entries.size > 10_000) {
        for (const k of entries.keys()) if (!current(k)) entries.delete(k);
      }
      return e.count === max;
    },
  };
}

export function registerAuthRoutes(app, ctx) {
  const { auth, config } = ctx;
  const limits = { perMinute: 5, overallPerMinute: 50, failuresPerHour: 20, ...ctx.loginLimits };
  // Keyed on the password actually tested, so junk scopes or decks that share
  // the global password do not open new budgets.
  const keyOf = (req) => `${clientIp(req, ctx.trustProxy)}|${req.login.target}`;
  const perClient = app.createRateLimit({ max: limits.perMinute, timeWindow: 60_000, keyGenerator: keyOf });
  const overall = app.createRateLimit({ max: limits.overallPerMinute, timeWindow: 60_000, keyGenerator: () => 'login' });
  const failures = createFailureLimit({ max: limits.failuresPerHour });

  function tooMany(reply, seconds) {
    reply.header('Retry-After', seconds);
    return reply.code(429).send({ error: 'too-many-attempts' });
  }

  // Works out which password a login tests, or the error to answer with.
  async function resolveLogin(body) {
    const { scope, deck, password } = body ?? {};
    if (!SCOPES.has(scope) || typeof password !== 'string' || password.length > MAX_PASSWORD
      || (deck !== undefined && deck !== null && !isValidSlug(deck))
      || (scope === 'viewer' && !deck)) {
      return { code: 400, error: 'bad-request' };
    }
    if (deck && !(await ctx.decks.exists(deck))) return { code: 404, error: 'no-deck' };
    if (scope === 'admin') return { hash: config.adminHash, target: 'admin', grantArgs: { admin: true } };
    if (scope === 'presenter') {
      const own = deck && deckAuth(config, deck).presenterHash;
      return {
        hash: deck ? auth.presenterHashFor(deck) : config.presenterHash,
        target: own ? `presenter:${deck}` : 'presenter',
        grantArgs: { present: [deck || '*'] },
      };
    }
    return { hash: deckAuth(config, deck).viewerHash, target: `viewer:${deck}`, grantArgs: { view: [deck] } };
  }

  // Requests that cannot test a password are answered before the limits, so
  // they never use up the shared budget.
  async function limit(req, reply) {
    const login = await resolveLogin(req.body);
    if (login.error) return reply.code(login.code).send({ error: login.error });
    if (!login.hash) return reply.code(409).send({ error: 'no-password-configured' });
    req.login = login;
    const wait = failures.blockedFor(keyOf(req));
    if (wait) return tooMany(reply, wait);
    for (const limiter of [perClient, overall]) {
      const r = await limiter(req);
      if (r.isExceeded) return tooMany(reply, r.ttlInSeconds);
    }
    return undefined;
  }

  app.decorateRequest('login', null);
  app.post('/api/login', { preHandler: limit }, async (req, reply) => {
    const { scope, deck, password } = req.body;
    const { hash, grantArgs } = req.login;
    if (!(await verifyPassword(password, hash))) {
      const who = { ip: clientIp(req, ctx.trustProxy), scope, deck: deck || undefined };
      req.log.warn(who, 'login failed');
      if (failures.fail(keyOf(req))) req.log.warn(who, 'login locked');
      return reply.code(401).send({ error: 'bad-password' });
    }
    await auth.grant(req, reply, grantArgs);
    return reply.code(204).send();
  });

  app.post('/api/logout', async (req, reply) => {
    await auth.logout(req, reply);
    return reply.code(204).send();
  });

  app.get('/api/session', async (req) => {
    const s = auth.getSession(req);
    return {
      admin: auth.canAdmin(req),
      present: s?.present ?? [],
      view: s?.view ?? [],
      localDirect: isLocalDirect(req),
    };
  });
}
