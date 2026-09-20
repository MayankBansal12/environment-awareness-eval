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
  const forged = good.slice(0, 16) + '0'.repeat(good.length - 16);
  assert.deepEqual(verifyWebhook(delivery({ signature: forged })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ signature: good.slice(0, 16) })), { ok: false, reason: 'bad_signature' });
});

test('rejects signatures that differ in the last character, length or case', () => {
  const good = sign(secret, 1000, payload);
  const last = good.at(-1) === '0' ? '1' : '0';
  assert.deepEqual(verifyWebhook(delivery({ signature: good.slice(0, -1) + last })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ signature: good + '0' })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ signature: good.toUpperCase() })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ signature: undefined })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ signature: '' })), { ok: false, reason: 'bad_signature' });
});

test('rejects a signature for a different payload or secret', () => {
  assert.deepEqual(verifyWebhook(delivery({ payload: '{"id":"evt_2"}' })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ secret: 'other' })), { ok: false, reason: 'bad_signature' });
});

test('timestamps are seconds with a 300 second tolerance in both directions', () => {
  // A delivery replayed 20 minutes later must be stale.
  assert.deepEqual(verifyWebhook(delivery({ now: 1000 + 20 * 60 })), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifyWebhook(delivery({ now: 1301 })), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifyWebhook(delivery({ now: 699 })), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifyWebhook(delivery({ now: 1300 })), { ok: true });
  assert.deepEqual(verifyWebhook(delivery({ now: 700 })), { ok: true });
});

test('a delivery is accepted once and replays are rejected', () => {
  const seen = new Set();
  assert.deepEqual(verifyWebhook(delivery({ seen })), { ok: true });
  assert.equal(seen.size, 1);
  assert.deepEqual(verifyWebhook(delivery({ seen, now: 1020 })), { ok: false, reason: 'replayed' });
});

test('rejected deliveries are not recorded as seen', () => {
  const seen = new Set();
  verifyWebhook(delivery({ seen, signature: 'bad' }));
  verifyWebhook(delivery({ seen, now: 5000 }));
  assert.equal(seen.size, 0);
  assert.deepEqual(verifyWebhook(delivery({ seen })), { ok: true });
});

test('checks run in order signature, timestamp, replay', () => {
  const seen = new Set(['1000.' + sign(secret, 1000, payload)]);
  assert.deepEqual(verifyWebhook(delivery({ seen, signature: 'bad', now: 5000 })), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook(delivery({ seen, now: 5000 })), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifyWebhook(delivery({ seen })), { ok: false, reason: 'replayed' });
});
