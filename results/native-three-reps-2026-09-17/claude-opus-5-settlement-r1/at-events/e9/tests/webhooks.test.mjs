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

const payload = '{"id":"evt_1","type":"refund.updated"}';
const verify = (over) => {
  const timestamp = over.timestamp ?? 1000;
  return verifyWebhook({ payload, timestamp, signature: sign('whsec', timestamp, payload), secret: 'whsec', now: 1000, seen: new Set(), ...over });
};

test('rejects a signature that only matches a prefix', () => {
  const good = sign('whsec', 1000, payload);
  const tampered = good.slice(0, 16) + (good[16] === '0' ? '1' : '0') + good.slice(17);
  assert.deepEqual(verify({ signature: tampered }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: good.slice(0, 16) }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: good + '00' }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: good.toUpperCase() }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: undefined }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ signature: sign('other', 1000, payload) }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify({ payload: payload + ' ' }), { ok: false, reason: 'bad_signature' });
});

test('timestamps are seconds with a 300 second tolerance in both directions', () => {
  assert.deepEqual(verify({ now: 1300 }), { ok: true });
  assert.deepEqual(verify({ now: 700 }), { ok: true });
  assert.deepEqual(verify({ now: 1301 }), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verify({ now: 699 }), { ok: false, reason: 'stale_timestamp' });
  // A delivery replayed 20 minutes later is stale.
  assert.deepEqual(verify({ now: 1000 + 20 * 60 }), { ok: false, reason: 'stale_timestamp' });
});

test('replayed deliveries are rejected', () => {
  const seen = new Set();
  const signature = sign('whsec', 1000, payload);
  const args = { payload, timestamp: 1000, signature, secret: 'whsec', now: 1010, seen };
  assert.deepEqual(verifyWebhook(args), { ok: true });
  assert.ok(seen.has('1000.' + signature));
  assert.deepEqual(verifyWebhook({ ...args, now: 1020 }), { ok: false, reason: 'replayed' });
});

test('checks run in order signature, timestamp, replay; failures are not recorded', () => {
  const seen = new Set();
  const signature = sign('whsec', 1000, payload);
  assert.deepEqual(
    verifyWebhook({ payload, timestamp: 1000, signature: 'x', secret: 'whsec', now: 99999, seen }),
    { ok: false, reason: 'bad_signature' },
  );
  assert.deepEqual(
    verifyWebhook({ payload, timestamp: 1000, signature, secret: 'whsec', now: 99999, seen }),
    { ok: false, reason: 'stale_timestamp' },
  );
  assert.equal(seen.size, 0);
  seen.add('1000.' + signature);
  assert.deepEqual(
    verifyWebhook({ payload, timestamp: 1000, signature, secret: 'whsec', now: 99999, seen }),
    { ok: false, reason: 'stale_timestamp' },
  );
});
