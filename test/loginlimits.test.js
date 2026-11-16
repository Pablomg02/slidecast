import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyedLimit, createGate, addressKey, BusyError } from '../src/loginlimits.js';

test('keyedLimit: sliding windows, per key, and a hit can be taken back', () => {
  let now = 0;
  const l = keyedLimit([{ max: 2, ms: 5000 }, { max: 3, ms: 60_000 }], () => now);
  l.hit('a');
  now = 1000;
  l.hit('a');
  assert.equal(l.wait('a'), 4000);
  assert.equal(l.wait('b'), 0);
  now = 5000;
  assert.equal(l.wait('a'), 0);
  const undo = l.hit('a');
  assert.equal(l.wait('a'), 55_000);
  undo();
  assert.equal(l.wait('a'), 0);
  now = 61_000;
  assert.equal(l.wait('a'), 0);
});

test('createGate: runs a few at once, queues more, then refuses with a wait', async () => {
  const gate = createGate({ running: 1, queued: 1 });
  let release;
  const first = gate.run(() => new Promise((r) => { release = r; }));
  const second = gate.run(async () => 'second');
  await assert.rejects(gate.run(async () => 'third'), (e) => e instanceof BusyError && e.retryAfter >= 1);
  release('first');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(await gate.run(async () => 'again'), 'again');
});

test('addressKey: IPv4 as it is, IPv6 by its /64', () => {
  assert.equal(addressKey('203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:0db8:0001:0002:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
  assert.equal(addressKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
});
