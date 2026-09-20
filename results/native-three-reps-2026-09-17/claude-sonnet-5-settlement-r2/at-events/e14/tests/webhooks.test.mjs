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

test('rejects a signature that only matches on a prefix', () => {
  const signature = sign('whsec', 1000, '{"id":"evt_1"}');
  const tampered = signature.slice(0, 16) + 'f'.repeat(signature.length - 16);
  assert.deepEqual(
    verifyWebhook({ payload: '{"id":"evt_1"}', timestamp: 1000, signature: tampered, secret: 'whsec', now: 1010, seen: new Set() }),
    { ok: false, reason: 'bad_signature' },
  );
});

test('rejects a signature computed with the wrong secret', () => {
  const signature = sign('other-secret', 1000, '{"id":"evt_1"}');
  assert.deepEqual(
    verifyWebhook({ payload: '{"id":"evt_1"}', timestamp: 1000, signature, secret: 'whsec', now: 1010, seen: new Set() }),
    { ok: false, reason: 'bad_signature' },
  );
});

test('rejects a timestamp more than 300s in the past', () => {
  const signature = sign('whsec', 1000, '{"id":"evt_1"}');
  assert.deepEqual(
    verifyWebhook({ payload: '{"id":"evt_1"}', timestamp: 1000, signature, secret: 'whsec', now: 1301, seen: new Set() }),
    { ok: false, reason: 'stale_timestamp' },
  );
});

test('rejects a timestamp more than 300s in the future', () => {
  const signature = sign('whsec', 1000, '{"id":"evt_1"}');
  assert.deepEqual(
    verifyWebhook({ payload: '{"id":"evt_1"}', timestamp: 1000, signature, secret: 'whsec', now: 699, seen: new Set() }),
    { ok: false, reason: 'stale_timestamp' },
  );
});

test('rejects a replayed delivery and accepts the first one', () => {
  const signature = sign('whsec', 1000, '{"id":"evt_1"}');
  const seen = new Set();
  assert.deepEqual(
    verifyWebhook({ payload: '{"id":"evt_1"}', timestamp: 1000, signature, secret: 'whsec', now: 1010, seen }),
    { ok: true },
  );
  assert.deepEqual(
    verifyWebhook({ payload: '{"id":"evt_1"}', timestamp: 1000, signature, secret: 'whsec', now: 1020, seen }),
    { ok: false, reason: 'replayed' },
  );
});
