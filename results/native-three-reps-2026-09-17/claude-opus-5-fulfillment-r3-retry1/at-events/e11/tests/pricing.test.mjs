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

const order = (coupons) => priceOrder({ lines: [{ unitMinor: 1000, quantity: 1 }], coupons });

test('total never goes below zero', () => {
  assert.deepEqual(order([{ type: 'fixed', value: 1500 }]), { subtotalMinor: 1000, discountMinor: 1000, totalMinor: 0 });
  assert.deepEqual(order([{ type: 'percent', value: 100 }, { type: 'fixed', value: 1 }]), { subtotalMinor: 1000, discountMinor: 1000, totalMinor: 0 });
});

test('percent coupons apply before fixed coupons regardless of order', () => {
  const expected = { subtotalMinor: 1000, discountMinor: 300, totalMinor: 700 };
  assert.deepEqual(order([{ type: 'fixed', value: 100 }, { type: 'percent', value: 20 }]), expected);
  assert.deepEqual(order([{ type: 'percent', value: 20 }, { type: 'fixed', value: 100 }]), expected);
});

test('percent coupons compound in the given order', () => {
  // 1000 -> -100 (10%) = 900 -> -450 (50%) = 450; then fixed 50 -> 400
  assert.deepEqual(order([{ type: 'fixed', value: 50 }, { type: 'percent', value: 10 }, { type: 'percent', value: 50 }]), {
    subtotalMinor: 1000,
    discountMinor: 600,
    totalMinor: 400,
  });
});

test('percent discounts round half to even', () => {
  // 50 * 5% = 2.5 -> 2 ; 70 * 5% = 3.5 -> 4 ; 30 * 5% = 1.5 -> 2
  const price = (unitMinor) => priceOrder({ lines: [{ unitMinor, quantity: 1 }], coupons: [{ type: 'percent', value: 5 }] }).totalMinor;
  assert.equal(price(50), 48);
  assert.equal(price(70), 66);
  assert.equal(price(30), 28);
  assert.equal(price(210), 200); // 10.5 -> 10 (Math.round would give 11 -> 199)
});

test('invalid coupons are rejected', () => {
  for (const coupon of [
    null,
    'percent',
    { type: 'percent', value: 0 },
    { type: 'percent', value: 101 },
    { type: 'percent', value: 12.5 },
    { type: 'percent', value: '10' },
    { type: 'fixed', value: 0 },
    { type: 'fixed', value: -100 },
    { type: 'fixed', value: 1.5 },
    { type: 'fixed', value: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'bogo', value: 1 },
    { value: 10 },
  ])
    assert.throws(() => order([coupon]), /invalid_coupon/);
  assert.throws(() => order('nope'), /invalid_coupon/);
});

test('invalid orders are rejected', () => {
  for (const lines of [
    undefined,
    [],
    [null],
    [{ unitMinor: -1, quantity: 1 }],
    [{ unitMinor: 1.5, quantity: 1 }],
    [{ unitMinor: 100, quantity: 0 }],
    [{ unitMinor: 100, quantity: 2.5 }],
    [{ unitMinor: Number.MAX_SAFE_INTEGER, quantity: 2 }],
  ])
    assert.throws(() => priceOrder({ lines }), /invalid_order/);
  assert.throws(() => priceOrder(), /invalid_order/);
});

test('free lines are allowed', () => {
  assert.deepEqual(priceOrder({ lines: [{ unitMinor: 0, quantity: 3 }], coupons: [{ type: 'fixed', value: 5 }] }), {
    subtotalMinor: 0,
    discountMinor: 0,
    totalMinor: 0,
  });
});
