import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verifyWebhook } from '../src/webhooks.mjs';

test('accepts a correctly signed delivery', () => {
  const signature = sign('whsec', 1000, '{"id":"evt_1"}');
  assert.deepEqual(
    verifyWebhook({ payload: '{"id":"evt_1"}', timestamp: 1000, signature, secret: 'whsec', now: 1010, seen: new Set() }),
    { ok: true },
  );
});

const payload = '{"id":"evt_1"}';
const secret = 'whsec';
const verify = (over) =>
  verifyWebhook({ payload, timestamp: 1000, signature: sign(secret, 1000, payload), secret, now: 1000, seen: new Set(), ...over });

test('rejects signatures that only partially match', () => {
  const good = sign(secret, 1000, payload);
  const flippedTail = good.slice(0, -1) + (good.at(-1) === '0' ? '1' : '0');
  assert.deepEqual(verify({ signature: flippedTail }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: good.slice(0, 16) }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: good + '00' }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: good.toUpperCase() }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: '' }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: undefined }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: sign('other', 1000, payload) }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ payload: '{"id":"evt_2"}' }), { ok: false, reason: 'bad_signature' });
});

test('timestamp tolerance is 300 seconds in either direction', () => {
  assert.deepEqual(verify({ now: 1300 }), { ok: true });
  assert.deepEqual(verify({ now: 700 }), { ok: true });
  assert.deepEqual(verify({ now: 1301 }), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verify({ now: 699 }), { ok: false, reason: 'stale_timestamp' });
  // A delivery replayed 20 minutes later is stale (seconds, not milliseconds).
  assert.deepEqual(verify({ now: 1000 + 20 * 60 }), { ok: false, reason: 'stale_timestamp' });
});

test('replayed deliveries are rejected', () => {
  const seen = new Set();
  assert.deepEqual(verify({ seen }), { ok: true });
  assert.ok(seen.has('1000.' + sign(secret, 1000, payload)));
  assert.deepEqual(verify({ seen, now: 1100 }), { ok: false, reason: 'replayed' });
});

test('checks run in order signature, timestamp, replay', () => {
  const seen = new Set();
  assert.deepEqual(verify({ seen }), { ok: true });
  // Stale and replayed -> stale; bad signature and stale -> bad_signature.
  assert.deepEqual(verify({ seen, now: 5000 }), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verify({ seen, now: 5000, signature: 'nope' }), { ok: false, reason: 'bad_signature' });
  // Rejected deliveries are not recorded.
  const fresh = new Set();
  verify({ seen: fresh, now: 5000 });
  verify({ seen: fresh, signature: 'nope' });
  assert.equal(fresh.size, 0);
});
