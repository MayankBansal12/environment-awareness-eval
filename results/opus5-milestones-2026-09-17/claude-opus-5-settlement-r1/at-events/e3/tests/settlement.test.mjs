import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../src/settlement.mjs';

test('pending charges are not settled', () => {
  const rows = settle({
    merchantId: 'm_1',
    from: 0,
    to: 100,
    refunds: [],
    charges: [
      { id: 'a', merchantId: 'm_1', amountMinor: 1000, currency: 'USD', plan: 'standard', status: 'captured', capturedAt: 5 },
      { id: 'b', merchantId: 'm_1', amountMinor: 700, currency: 'USD', plan: 'standard', status: 'pending', capturedAt: 6 },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grossMinor, 1000);
});
