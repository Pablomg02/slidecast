import { randomBytes } from 'node:crypto';
import { slidingLimit } from './rooms.js';

// Raising a hand: 2 per 5 s and 4 per 30 s (D13 of 0003); renames: 5 per 30 s.
export const RAISE_LIMITS = [{ max: 2, ms: 5000 }, { max: 4, ms: 30_000 }];
const NAME_LIMITS = [{ max: 5, ms: 30_000 }];

// The participants of one room, in memory only (D5–D7, D13). A participant is
// found by the hash of its token; presenters only ever see its public id.
export function createPeople({ graceMs, onExpire = () => {} }) {
  const byId = new Map();
  const byHash = new Map();
  let nextN = 1;
  let seq = 0; // orders hands that changed state in the same millisecond

  function remove(p) {
    clearTimeout(p.timer);
    byId.delete(p.id);
    byHash.delete(p.hash);
    if (!byId.size) nextN = 1;
  }

  // Queued hands in queue order.
  function queue() {
    return [...byId.values()].filter((p) => p.hand?.state === 'queued')
      .sort((a, b) => a.hand.seq - b.hand.seq);
  }

  return {
    get size() { return byId.size; },
    all: () => byId.values(),
    byId: (id) => (typeof id === 'string' ? byId.get(id) : undefined),
    byHash: (hash) => byHash.get(hash),
    create(hash) {
      const p = {
        id: randomBytes(6).toString('hex'),
        hash,
        n: nextN++,
        name: null,
        hand: null,
        sockets: new Set(),
        timer: null,
        raises: slidingLimit(RAISE_LIMITS),
        renames: slidingLimit(NAME_LIMITS),
      };
      byId.set(p.id, p);
      byHash.set(hash, p);
      return p;
    },
    attach(p, client) {
      clearTimeout(p.timer);
      p.timer = null;
      p.sockets.add(client);
    },
    // The last socket left: keep the participant for graceMs (phone locks).
    detach(p, client) {
      p.sockets.delete(client);
      if (p.sockets.size || !byId.has(p.id)) return;
      p.timer = setTimeout(() => {
        remove(p);
        onExpire(p);
      }, graceMs);
      p.timer.unref?.();
    },
    remove,
    clear() {
      for (const p of byId.values()) clearTimeout(p.timer);
      byId.clear();
      byHash.clear();
      nextN = 1;
    },
    queue,
    // A hand entered a new state now.
    stamp(hand, now) {
      hand.since = now;
      hand.seq = ++seq;
    },
    // 1-based place in the queue, or null.
    position(p) {
      if (p.hand?.state !== 'queued') return null;
      return queue().indexOf(p) + 1;
    },
    // What presenters see. A hand's `ago` counts from raising it, `wait`
    // from entering its current state (the order within that state).
    list(now) {
      return [...byId.values()].map((p) => ({
        id: p.id,
        n: p.n,
        name: p.name,
        online: p.sockets.size > 0,
        hand: p.hand && {
          state: p.hand.state,
          note: p.hand.note,
          ago: now - p.hand.at,
          wait: now - p.hand.since,
          seq: p.hand.seq,
        },
      }));
    },
  };
}
