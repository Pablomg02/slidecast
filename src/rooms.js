import { saveConfig } from './config.js';

// Room settings per deck (D1 of 0003), kept in config.json under rooms[slug].
export const ROOM_DEFAULTS = { open: false, maxPresenters: 20, maxViewers: 200, askNames: true, hands: true };
export const ROOM_RANGES = { maxPresenters: [1, 20], maxViewers: [1, 1000] };

export const MAX_NAME = 40;
export const MAX_NOTE = 280;
const MAX_NOTE_LINES = 5;

// Validates a PATCH body; returns {patch} or {error}.
export function parseRoomPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad-request' };
  const patch = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'open' || k === 'askNames' || k === 'hands' || k === 'only') {
      if (typeof v !== 'boolean') return { error: 'bad-request' };
    } else if (k in ROOM_RANGES) {
      const [min, max] = ROOM_RANGES[k];
      if (!Number.isInteger(v) || v < min || v > max) return { error: 'bad-request' };
    } else {
      return { error: 'bad-request' };
    }
    patch[k] = v;
  }
  return { patch };
}

export function createRooms(ctx) {
  const { config } = ctx;
  config.rooms ??= {};

  function settings(slug) {
    const s = { ...ROOM_DEFAULTS, ...config.rooms[slug] };
    if (ctx.decks.single) s.open = true;
    return s;
  }

  return {
    settings,
    isOpen: (slug) => settings(slug).open,
    // Applies a validated patch and saves; `only` also closes every other room.
    async update(slug, { only = false, ...patch }) {
      if (only) {
        patch.open = true;
        for (const [other, r] of Object.entries(config.rooms)) if (other !== slug) r.open = false;
      }
      config.rooms[slug] = { ...settings(slug), ...patch };
      await saveConfig(ctx.stateDir, config);
      return settings(slug);
    },
    async remove(slug) {
      if (!(slug in config.rooms)) return;
      delete config.rooms[slug];
      await saveConfig(ctx.stateDir, config);
    },
  };
}

const CONTROL = /(?!\u200d)[\p{Cc}\p{Cf}\u2028\u2029]/gu;

// Display name: NFC, no control characters, spaces collapsed. Empty → null
// (anonymous). Not a string → undefined (invalid).
export function cleanName(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 400) return undefined;
  const s = v.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  return s ? [...s].slice(0, MAX_NAME).join('') : null;
}

// Hand note: like a name, but line breaks survive (at most MAX_NOTE_LINES lines).
export function cleanNote(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 4000) return undefined;
  const lines = v.normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim());
  const kept = lines.slice(0, MAX_NOTE_LINES - 1);
  kept.push(lines.slice(MAX_NOTE_LINES - 1).join(' '));
  const s = kept.join('\n').replace(/\n{2,}/g, '\n').trim();
  return [...s].slice(0, MAX_NOTE).join('');
}

// Events in sliding windows, e.g. [{max: 2, ms: 5000}, {max: 4, ms: 30000}].
export function slidingLimit(windows) {
  const keep = Math.max(...windows.map((w) => w.max));
  const times = [];
  return {
    // Milliseconds until one more event is allowed (0: now).
    wait(now) {
      let w = 0;
      for (const { max, ms } of windows) {
        if (times.length >= max) w = Math.max(w, times[times.length - max] + ms - now);
      }
      return Math.max(0, w);
    },
    hit(now) {
      times.push(now);
      if (times.length > keep) times.shift();
    },
  };
}
