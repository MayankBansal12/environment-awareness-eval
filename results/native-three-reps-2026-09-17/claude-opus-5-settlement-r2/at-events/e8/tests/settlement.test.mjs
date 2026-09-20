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

const charge = (over) => ({ merchantId: 'm_1', amountMinor: 1000, currency: 'USD', plan: 'standard', status: 'captured', capturedAt: 5, ...over });

test('only captured charges are settled', () => {
  const rows = settle({
    merchantId: 'm_1', from: 0, to: 100, refunds: [],
    charges: [
      charge({ id: 'a' }),
      charge({ id: 'b', status: 'pending' }),
      charge({ id: 'c', status: 'authorized' }),
      charge({ id: 'd', status: 'failed' }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grossMinor, 1000);
  assert.equal(rows[0].feesMinor, 59);
});

test('one row per currency, sorted by currency code', () => {
  const rows = settle({
    merchantId: 'm_1', from: 0, to: 100,
    charges: [
      charge({ id: 'a', currency: 'USD' }),
      charge({ id: 'b', currency: 'EUR', amountMinor: 2000 }),
      charge({ id: 'c', currency: 'USD', capturedAt: 100 }), // outside window
      charge({ id: 'd', currency: 'GBP', merchantId: 'm_2' }), // other merchant
    ],
    refunds: [
      { id: 'rf_1', merchantId: 'm_1', chargeId: 'x', amountMinor: 300, feeReturnMinor: 10, currency: 'CAD', createdAt: 0 },
      { id: 'rf_2', merchantId: 'm_1', chargeId: 'a', amountMinor: 400, feeReturnMinor: 23, currency: 'USD', createdAt: 50 },
    ],
  });
  assert.deepEqual(rows, [
    { currency: 'CAD', grossMinor: 0, refundsMinor: 300, feesMinor: -10, netMinor: -290, payoutMinor: 0, carryoverMinor: 290 },
    { currency: 'EUR', grossMinor: 2000, refundsMinor: 0, feesMinor: 88, netMinor: 1912, payoutMinor: 1912, carryoverMinor: 0 },
    { currency: 'USD', grossMinor: 1000, refundsMinor: 400, feesMinor: 36, netMinor: 564, payoutMinor: 564, carryoverMinor: 0 },
  ]);
});

test('no counted activity yields no rows', () => {
  assert.deepEqual(settle({ merchantId: 'm_1', from: 0, to: 100, charges: [charge({ id: 'a', status: 'pending' })], refunds: [] }), []);
});

test('negative net floors payout at zero and reports carryover', () => {
  const refunds = [
    { id: 'rf_1', merchantId: 'm_1', chargeId: 'old', amountMinor: 1500, feeReturnMinor: 50, currency: 'USD', createdAt: 10 },
  ];
  const [negative] = settle({ merchantId: 'm_1', from: 0, to: 100, charges: [charge({ id: 'a' })], refunds });
  // gross 1000, refunds 1500, fees 59 - 50 = 9 -> net -509
  assert.deepEqual(negative, {
    currency: 'USD', grossMinor: 1000, refundsMinor: 1500, feesMinor: 9, netMinor: -509, payoutMinor: 0, carryoverMinor: 509,
  });
  const [positive] = settle({ merchantId: 'm_1', from: 0, to: 100, charges: [charge({ id: 'a' })], refunds: [] });
  assert.equal(positive.netMinor, 941);
  assert.equal(positive.payoutMinor, 941);
  assert.equal(positive.carryoverMinor, 0);
  // Net of exactly zero pays nothing and carries nothing.
  const [zero] = settle({
    merchantId: 'm_1', from: 0, to: 100, charges: [charge({ id: 'a' })],
    refunds: [{ id: 'rf_2', merchantId: 'm_1', chargeId: 'a', amountMinor: 1000, feeReturnMinor: 59, currency: 'USD', createdAt: 10 }],
  });
  assert.equal(zero.netMinor, 0);
  assert.equal(zero.payoutMinor, 0);
  assert.equal(zero.carryoverMinor, 0);
});
