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

const charge = (over) => ({ merchantId: 'm_1', plan: 'standard', status: 'captured', capturedAt: 5, currency: 'USD', ...over });

test('failed charges, other merchants and out-of-window charges are not settled', () => {
  const rows = settle({
    merchantId: 'm_1',
    from: 0,
    to: 100,
    refunds: [],
    charges: [
      charge({ id: 'a', amountMinor: 1000 }),
      charge({ id: 'b', amountMinor: 700, status: 'failed' }),
      charge({ id: 'c', amountMinor: 700, merchantId: 'm_2' }),
      charge({ id: 'd', amountMinor: 700, capturedAt: 100 }),
      charge({ id: 'e', amountMinor: 700, capturedAt: -1 }),
    ],
  });
  assert.deepEqual(rows, [
    { currency: 'USD', grossMinor: 1000, refundsMinor: 0, feesMinor: 59, netMinor: 941, payoutMinor: 941, carryoverMinor: 0 },
  ]);
});

test('one row per currency, sorted, with refunds attributed to their currency', () => {
  const rows = settle({
    merchantId: 'm_1',
    from: 0,
    to: 100,
    charges: [
      charge({ id: 'u', amountMinor: 1000, currency: 'USD' }),
      charge({ id: 'e', amountMinor: 2000, currency: 'EUR', plan: 'growth' }),
    ],
    refunds: [
      { id: 'rf_1', merchantId: 'm_1', chargeId: 'u', amountMinor: 400, feeReturnMinor: 23, currency: 'USD', createdAt: 50 },
      { id: 'rf_2', merchantId: 'm_1', chargeId: 'x', amountMinor: 100, feeReturnMinor: 5, currency: 'GBP', createdAt: 50 },
      { id: 'rf_3', merchantId: 'm_1', chargeId: 'u', amountMinor: 100, feeReturnMinor: 5, currency: 'USD', createdAt: 100 },
      { id: 'rf_4', merchantId: 'm_2', chargeId: 'u', amountMinor: 100, feeReturnMinor: 5, currency: 'USD', createdAt: 50 },
    ],
  });
  assert.deepEqual(rows, [
    { currency: 'EUR', grossMinor: 2000, refundsMinor: 0, feesMinor: 75, netMinor: 1925, payoutMinor: 1925, carryoverMinor: 0 },
    { currency: 'GBP', grossMinor: 0, refundsMinor: 100, feesMinor: -5, netMinor: -95, payoutMinor: -95, carryoverMinor: 0 },
    { currency: 'USD', grossMinor: 1000, refundsMinor: 400, feesMinor: 36, netMinor: 564, payoutMinor: 564, carryoverMinor: 0 },
  ]);
});

test('no counted items yields no rows', () => {
  assert.deepEqual(
    settle({ merchantId: 'm_1', from: 0, to: 100, refunds: [], charges: [charge({ id: 'p', amountMinor: 10, status: 'pending' })] }),
    [],
  );
});
