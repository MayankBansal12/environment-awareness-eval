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
