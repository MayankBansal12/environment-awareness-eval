import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verifyWebhook } from '../src/webhooks.mjs';

const payload = '{"id":"evt_1"}';
const secret = 'whsec';
const delivery = (overrides = {}) => ({
  payload,
  timestamp: 1000,
  signature: sign(secret, 1000, payload),
  secret,
  now: 1010,
  seen: new Set(),
  ...overrides,
});

test('accepts a correctly signed delivery', () => {
  const signature = sign('whsec', 1000, '{"id":"evt_1"}');
  assert.deepEqual(
    verifyWebhook({ payload: '{"id":"evt_1"}', timestamp: 1000, signature, secret: 'whsec', now: 1010, seen: new Set() }),
    { ok: true },
  );
});

test('rejects a signature that only matches a prefix', () => {
  const good = sign(secret, 1000, payload);
  const forged = good.slice(0, 16) + '0'.repeat(48);
  assert.notEqual(forged, good);
  assert.deepEqual(verifyWebhook(delivery({ signature: forged })), { ok: false, reason: 'bad_signature' });
});

test('rejects truncated, extended, uppercase and non-string signatures', () => {
  const good = sign(secret, 1000, payload);
  for (const signature of [good.slice(0, 16), good.slice(0, 63), good + '0', good.toUpperCase(), '', undefined, null, 42]) {
    assert.deepEqual(verifyWebhook(delivery({ signature })), { ok: false, reason: 'bad_signature' }, String(signature));
  }
});

test('rejects a signature for a different payload, timestamp or secret', () => {
  assert.deepEqual(verifyWebhook(delivery({ payload: '{"id":"evt_2"}' })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ timestamp: 1001, now: 1001 })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ secret: 'other' })), { ok: false, reason: 'bad_signature' });
});

test('timestamps are in seconds with a 300 second tolerance in both directions', () => {
  assert.deepEqual(verifyWebhook(delivery({ now: 1300 })), { ok: true });
  assert.deepEqual(verifyWebhook(delivery({ now: 700 })), { ok: true });
  assert.deepEqual(verifyWebhook(delivery({ now: 1301 })), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifyWebhook(delivery({ now: 699 })), { ok: false, reason: 'stale_timestamp' });
  // A delivery replayed 20 minutes later is stale.
  assert.deepEqual(verifyWebhook(delivery({ now: 1000 + 20 * 60 })), { ok: false, reason: 'stale_timestamp' });
});

test('a delivery is accepted once and then rejected as replayed', () => {
  const seen = new Set();
  assert.deepEqual(verifyWebhook(delivery({ seen })), { ok: true });
  assert.ok(seen.has('1000.' + sign(secret, 1000, payload)));
  assert.deepEqual(verifyWebhook(delivery({ seen, now: 1020 })), { ok: false, reason: 'replayed' });
});

test('checks run in order signature, timestamp, replay', () => {
  const seen = new Set();
  verifyWebhook(delivery({ seen }));
  // bad signature wins over stale and replay
  assert.deepEqual(
    verifyWebhook(delivery({ seen, signature: 'f'.repeat(64), now: 5000 })),
    { ok: false, reason: 'bad_signature' },
  );
  // stale wins over replay
  assert.deepEqual(verifyWebhook(delivery({ seen, now: 5000 })), { ok: false, reason: 'stale_timestamp' });
  // rejected deliveries are not recorded
  const fresh = new Set();
  verifyWebhook(delivery({ seen: fresh, now: 5000 }));
  verifyWebhook(delivery({ seen: fresh, signature: 'f'.repeat(64) }));
  assert.equal(fresh.size, 0);
});
