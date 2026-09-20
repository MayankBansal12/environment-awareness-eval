import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../src/settlement.mjs';

const charge = (overrides) => ({ merchantId: 'm_1', currency: 'USD', plan: 'standard', status: 'captured', capturedAt: 5, ...overrides });
const refund = (overrides) => ({ merchantId: 'm_1', currency: 'USD', createdAt: 5, ...overrides });

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

test('only captured charges of the merchant inside [from, to) are counted', () => {
  const rows = settle({
    merchantId: 'm_1',
    from: 10,
    to: 20,
    refunds: [],
    charges: [
      charge({ id: 'a', amountMinor: 1000, capturedAt: 10 }),
      charge({ id: 'b', amountMinor: 700, status: 'failed', capturedAt: 11 }),
      charge({ id: 'c', amountMinor: 700, status: 'authorized', capturedAt: 11 }),
      charge({ id: 'd', amountMinor: 700, capturedAt: 20 }),
      charge({ id: 'e', amountMinor: 700, capturedAt: 9 }),
      charge({ id: 'f', amountMinor: 700, merchantId: 'm_2', capturedAt: 12 }),
    ],
  });
  assert.deepEqual(rows, [
    { currency: 'USD', grossMinor: 1000, refundsMinor: 0, feesMinor: 59, netMinor: 941, payoutMinor: 941, carryoverMinor: 0 },
  ]);
});

test('one row per currency, sorted by currency code', () => {
  const rows = settle({
    merchantId: 'm_1',
    from: 0,
    to: 100,
    charges: [
      charge({ id: 'u', amountMinor: 1000, currency: 'USD' }),
      charge({ id: 'e', amountMinor: 2000, currency: 'EUR', plan: 'growth' }),
      charge({ id: 'g', amountMinor: 500, currency: 'GBP', status: 'pending' }),
    ],
    refunds: [refund({ id: 'rf_1', amountMinor: 200, feeReturnMinor: 5, currency: 'CAD' })],
  });
  assert.deepEqual(rows.map((row) => row.currency), ['CAD', 'EUR', 'USD']);
  assert.deepEqual(rows[1], { currency: 'EUR', grossMinor: 2000, refundsMinor: 0, feesMinor: 75, netMinor: 1925, payoutMinor: 1925, carryoverMinor: 0 });
  assert.deepEqual(rows[2], { currency: 'USD', grossMinor: 1000, refundsMinor: 0, feesMinor: 59, netMinor: 941, payoutMinor: 941, carryoverMinor: 0 });
});

test('refunds in the window reduce net and fees by the returned fee', () => {
  const rows = settle({
    merchantId: 'm_1',
    from: 0,
    to: 100,
    charges: [charge({ id: 'a', amountMinor: 1000 })],
    refunds: [
      refund({ id: 'rf_1', amountMinor: 400, feeReturnMinor: 23, createdAt: 50 }),
      refund({ id: 'rf_2', amountMinor: 100, feeReturnMinor: 5, createdAt: 100 }),
      refund({ id: 'rf_3', amountMinor: 100, feeReturnMinor: 5, merchantId: 'm_2' }),
    ],
  });
  assert.deepEqual(rows, [
    { currency: 'USD', grossMinor: 1000, refundsMinor: 400, feesMinor: 36, netMinor: 564, payoutMinor: 564, carryoverMinor: 0 },
  ]);
});

test('negative net pays out 0 and carries the shortfall over', () => {
  const rows = settle({
    merchantId: 'm_1',
    from: 100,
    to: 200,
    charges: [charge({ id: 'a', amountMinor: 1000, capturedAt: 50 })],
    refunds: [refund({ id: 'rf_1', amountMinor: 1000, feeReturnMinor: 59, createdAt: 150 })],
  });
  assert.deepEqual(rows, [
    { currency: 'USD', grossMinor: 0, refundsMinor: 1000, feesMinor: -59, netMinor: -941, payoutMinor: 0, carryoverMinor: 941 },
  ]);
});

test('zero net has no carryover', () => {
  const [row] = settle({
    merchantId: 'm_1',
    from: 0,
    to: 100,
    charges: [charge({ id: 'a', amountMinor: 1000 })],
    refunds: [refund({ id: 'rf_1', amountMinor: 941, feeReturnMinor: 0 })],
  });
  assert.equal(row.netMinor, 0);
  assert.equal(row.payoutMinor, 0);
  assert.equal(row.carryoverMinor, 0);
});

test('no counted charges or refunds gives no rows', () => {
  assert.deepEqual(
    settle({ merchantId: 'm_1', from: 0, to: 100, charges: [charge({ id: 'a', amountMinor: 1, status: 'pending' })], refunds: [] }),
    [],
  );
});
