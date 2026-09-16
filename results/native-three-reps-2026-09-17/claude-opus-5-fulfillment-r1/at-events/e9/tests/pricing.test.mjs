import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceOrder } from '../src/pricing.mjs';

test('prices an order without coupons', () => {
  assert.deepEqual(priceOrder({ lines: [{ unitMinor: 250, quantity: 4 }] }), {
    subtotalMinor: 1000,
    discountMinor: 0,
    totalMinor: 1000,
  });
});

const order = (coupons, unitMinor = 1000, quantity = 1) => priceOrder({ lines: [{ unitMinor, quantity }], coupons });

test('total never goes below zero', () => {
  assert.deepEqual(order([{ type: 'fixed', value: 1500 }]), { subtotalMinor: 1000, discountMinor: 1000, totalMinor: 0 });
  assert.deepEqual(order([{ type: 'percent', value: 100 }, { type: 'fixed', value: 1 }]), { subtotalMinor: 1000, discountMinor: 1000, totalMinor: 0 });
});

test('percent coupons apply before fixed coupons regardless of order', () => {
  const expected = { subtotalMinor: 1000, discountMinor: 300, totalMinor: 700 };
  assert.deepEqual(order([{ type: 'fixed', value: 100 }, { type: 'percent', value: 20 }]), expected);
  assert.deepEqual(order([{ type: 'percent', value: 20 }, { type: 'fixed', value: 100 }]), expected);
});

test('percent coupons compound on the running total in given order', () => {
  // 1000 -> -10% (100) = 900 -> -15% of 900 = 135 -> 765
  assert.equal(order([{ type: 'percent', value: 10 }, { type: 'fixed', value: 5 }, { type: 'percent', value: 15 }]).totalMinor, 760);
});

test('percent discounts round half to even', () => {
  // 50 * 5% = 2.5 -> 2 ; 150 * 5% = 7.5 -> 8 ; 30 * 5% = 1.5 -> 2
  assert.equal(order([{ type: 'percent', value: 5 }], 50).discountMinor, 2);
  assert.equal(order([{ type: 'percent', value: 5 }], 150).discountMinor, 8);
  assert.equal(order([{ type: 'percent', value: 5 }], 30).discountMinor, 2);
  // 1001 * 50% = 500.5 -> 500 (Math.round would give 501)
  assert.equal(order([{ type: 'percent', value: 50 }], 1001).discountMinor, 500);
});

test('percent rounding is exact for very large totals', () => {
  // 9007199254740990 * 15 = 135107988821114850 (beyond 2^53); /100 = 1351079888211148.5 -> even -> ...148
  assert.equal(order([{ type: 'percent', value: 15 }], 9007199254740990).discountMinor, 1351079888211148);
  // 9007199254740990 * 5 / 100 = 450359962737049.5 -> even -> ...050
  assert.equal(order([{ type: 'percent', value: 5 }], 9007199254740990).discountMinor, 450359962737050);
});

test('invalid coupons throw invalid_coupon', () => {
  for (const coupon of [
    null, 'percent', {}, { type: 'percent', value: 0 }, { type: 'percent', value: 101 },
    { type: 'percent', value: 12.5 }, { type: 'percent', value: '10' }, { type: 'fixed', value: 0 },
    { type: 'fixed', value: -5 }, { type: 'fixed', value: 1.5 }, { type: 'fixed', value: 2 ** 53 },
    { type: 'bogo', value: 1 },
  ])
    assert.throws(() => order([coupon]), /invalid_coupon/, JSON.stringify(coupon));
  assert.throws(() => priceOrder({ lines: [{ unitMinor: 1, quantity: 1 }], coupons: 'x' }), /invalid_coupon/);
});

test('invalid orders throw invalid_order', () => {
  for (const lines of [undefined, [], [null], [{ unitMinor: -1, quantity: 1 }], [{ unitMinor: 1.5, quantity: 1 }],
    [{ unitMinor: 1, quantity: 0 }], [{ unitMinor: 1, quantity: 2.5 }], [{ unitMinor: '1', quantity: 1 }],
    [{ unitMinor: Number.MAX_SAFE_INTEGER, quantity: 2 }]])
    assert.throws(() => priceOrder({ lines }), /invalid_order/, JSON.stringify(lines));
});

test('free items are allowed', () => {
  assert.deepEqual(order([{ type: 'fixed', value: 10 }], 0), { subtotalMinor: 0, discountMinor: 0, totalMinor: 0 });
});
