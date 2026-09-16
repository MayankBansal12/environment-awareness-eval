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

test('total never goes below zero', () => {
  assert.deepEqual(priceOrder({ lines: [{ unitMinor: 500, quantity: 1 }], coupons: [{ type: 'fixed', value: 800 }] }), {
    subtotalMinor: 500,
    discountMinor: 500,
    totalMinor: 0,
  });
  assert.equal(
    priceOrder({ lines: [{ unitMinor: 500, quantity: 1 }], coupons: [{ type: 'percent', value: 100 }, { type: 'fixed', value: 1 }] }).totalMinor,
    0,
  );
});

test('percent coupons apply before fixed regardless of order', () => {
  const lines = [{ unitMinor: 1000, quantity: 1 }];
  const percent = { type: 'percent', value: 10 };
  const fixed = { type: 'fixed', value: 200 };
  const expected = { subtotalMinor: 1000, discountMinor: 300, totalMinor: 700 };
  assert.deepEqual(priceOrder({ lines, coupons: [fixed, percent] }), expected);
  assert.deepEqual(priceOrder({ lines, coupons: [percent, fixed] }), expected);
});

test('percent coupons compound in given order with half-even rounding', () => {
  // 25 * 10 / 100 = 2.5 -> 2 (even); 23 * 50 / 100 = 11.5 -> 12 (even)
  assert.deepEqual(
    priceOrder({ lines: [{ unitMinor: 25, quantity: 1 }], coupons: [{ type: 'percent', value: 10 }, { type: 'percent', value: 50 }] }),
    { subtotalMinor: 25, discountMinor: 14, totalMinor: 11 },
  );
  // 5 * 50 / 100 = 2.5 -> 2 under half-even (Math.round would give 3)
  assert.equal(priceOrder({ lines: [{ unitMinor: 5, quantity: 1 }], coupons: [{ type: 'percent', value: 50 }] }).totalMinor, 3);
});

test('invalid coupons throw invalid_coupon', () => {
  const lines = [{ unitMinor: 100, quantity: 1 }];
  const bad = [
    { type: 'percent', value: 0 },
    { type: 'percent', value: 101 },
    { type: 'percent', value: 12.5 },
    { type: 'percent', value: '10' },
    { type: 'fixed', value: 0 },
    { type: 'fixed', value: -5 },
    { type: 'fixed', value: 1.5 },
    { type: 'fixed', value: 2 ** 53 },
    { type: 'bogo', value: 1 },
    {},
    null,
  ];
  for (const coupon of bad) assert.throws(() => priceOrder({ lines, coupons: [coupon] }), /invalid_coupon/, JSON.stringify(coupon));
  assert.throws(() => priceOrder({ lines, coupons: 'SAVE10' }), /invalid_coupon/);
});

test('invalid orders throw invalid_order', () => {
  for (const lines of [undefined, [], 'x', [null], [{ unitMinor: -1, quantity: 1 }], [{ unitMinor: 1.5, quantity: 1 }], [{ unitMinor: 1, quantity: 0 }], [{ unitMinor: 1, quantity: 2.5 }], [{ unitMinor: '1', quantity: 1 }]])
    assert.throws(() => priceOrder({ lines }), /invalid_order/, JSON.stringify(lines));
});

test('boundary coupon values are accepted', () => {
  const lines = [{ unitMinor: 100, quantity: 2 }];
  assert.equal(priceOrder({ lines, coupons: [{ type: 'percent', value: 1 }] }).totalMinor, 198);
  assert.equal(priceOrder({ lines, coupons: [{ type: 'fixed', value: 1 }] }).totalMinor, 199);
});
