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

test('percent coupons apply before fixed coupons regardless of input order', () => {
  const lines = [{ unitMinor: 1000, quantity: 1 }];
  const percentFirst = priceOrder({
    lines,
    coupons: [
      { type: 'percent', value: 50 },
      { type: 'fixed', value: 300 },
    ],
  });
  const fixedFirst = priceOrder({
    lines,
    coupons: [
      { type: 'fixed', value: 300 },
      { type: 'percent', value: 50 },
    ],
  });
  assert.deepEqual(percentFirst, { subtotalMinor: 1000, discountMinor: 800, totalMinor: 200 });
  assert.deepEqual(fixedFirst, percentFirst);
});

test('total never goes below 0 even with stacked fixed coupons', () => {
  const result = priceOrder({
    lines: [{ unitMinor: 500, quantity: 1 }],
    coupons: [
      { type: 'fixed', value: 300 },
      { type: 'fixed', value: 400 },
    ],
  });
  assert.deepEqual(result, { subtotalMinor: 500, discountMinor: 500, totalMinor: 0 });
});

test('percent coupon discount uses round-half-even', () => {
  const result = priceOrder({
    lines: [{ unitMinor: 25, quantity: 1 }],
    coupons: [{ type: 'percent', value: 50 }],
  });
  // 25 * 50 / 100 = 12.5 -> round half to even -> 12
  assert.deepEqual(result, { subtotalMinor: 25, discountMinor: 12, totalMinor: 13 });
});

test('rejects invalid coupons', () => {
  const lines = [{ unitMinor: 1000, quantity: 1 }];
  assert.throws(() => priceOrder({ lines, coupons: [{ type: 'percent', value: 0 }] }), /invalid_coupon/);
  assert.throws(() => priceOrder({ lines, coupons: [{ type: 'percent', value: 101 }] }), /invalid_coupon/);
  assert.throws(() => priceOrder({ lines, coupons: [{ type: 'percent', value: 1.5 }] }), /invalid_coupon/);
  assert.throws(() => priceOrder({ lines, coupons: [{ type: 'fixed', value: 0 }] }), /invalid_coupon/);
  assert.throws(() => priceOrder({ lines, coupons: [{ type: 'fixed', value: -5 }] }), /invalid_coupon/);
  assert.throws(() => priceOrder({ lines, coupons: [{ type: 'other', value: 5 }] }), /invalid_coupon/);
});
