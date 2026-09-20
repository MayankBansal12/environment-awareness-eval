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

const order = (coupons, unitMinor = 1000) => priceOrder({ lines: [{ unitMinor, quantity: 1 }], coupons });

test('CHK-12: total never goes below zero', () => {
  assert.deepEqual(order([{ type: 'fixed', value: 1500 }]), {
    subtotalMinor: 1000,
    discountMinor: 1000,
    totalMinor: 0,
  });
  assert.equal(order([{ type: 'percent', value: 100 }, { type: 'fixed', value: 1 }]).totalMinor, 0);
});

test('CHK-12: percent coupons apply before fixed regardless of given order', () => {
  const expected = { subtotalMinor: 1000, discountMinor: 200, totalMinor: 800 };
  assert.deepEqual(order([{ type: 'fixed', value: 100 }, { type: 'percent', value: 10 }]), expected);
  assert.deepEqual(order([{ type: 'percent', value: 10 }, { type: 'fixed', value: 100 }]), expected);
});

test('CHK-12: stacked percent coupons compound on the running total', () => {
  // 1000 -> -100 = 900 -> -90 = 810
  assert.equal(order([{ type: 'percent', value: 10 }, { type: 'percent', value: 10 }]).totalMinor, 810);
});

test('CHK-12: percent discounts round half to even', () => {
  // 50% of 25 = 12.5 -> 12 (even); 50% of 35 = 17.5 -> 18 (even)
  assert.equal(order([{ type: 'percent', value: 50 }], 25).discountMinor, 12);
  assert.equal(order([{ type: 'percent', value: 50 }], 35).discountMinor, 18);
  // 10% of 1005 = 100.5 -> 100
  assert.equal(order([{ type: 'percent', value: 10 }], 1005).discountMinor, 100);
});

test('CHK-12: invalid coupons are rejected', () => {
  const bad = [
    { type: 'percent', value: 0 },
    { type: 'percent', value: 101 },
    { type: 'percent', value: 12.5 },
    { type: 'percent', value: '10' },
    { type: 'fixed', value: 0 },
    { type: 'fixed', value: -5 },
    { type: 'fixed', value: 1.5 },
    { type: 'fixed', value: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'bogo', value: 1 },
    { value: 10 },
    null,
  ];
  for (const coupon of bad) assert.throws(() => order([coupon]), /invalid_coupon/, JSON.stringify(coupon));
  // A bad coupon is rejected even when a valid one precedes it.
  assert.throws(() => order([{ type: 'fixed', value: 5 }, { type: 'fixed', value: -5 }]), /invalid_coupon/);
});

test('CHK-12: invalid lines are rejected', () => {
  const bad = [
    [],
    [{ unitMinor: -1, quantity: 1 }],
    [{ unitMinor: 1.5, quantity: 1 }],
    [{ unitMinor: 100, quantity: 0 }],
    [{ unitMinor: 100, quantity: 2.5 }],
    [null],
  ];
  for (const lines of bad) assert.throws(() => priceOrder({ lines }), /invalid_order/);
  assert.throws(() => priceOrder({ lines: 'nope' }), /invalid_order/);
});
