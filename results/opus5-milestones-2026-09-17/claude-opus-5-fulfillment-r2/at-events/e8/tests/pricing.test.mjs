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
  assert.deepEqual(
    priceOrder({ lines: [{ unitMinor: 500, quantity: 1 }], coupons: [{ type: 'fixed', value: 800 }] }),
    { subtotalMinor: 500, discountMinor: 500, totalMinor: 0 },
  );
  assert.deepEqual(
    priceOrder({
      lines: [{ unitMinor: 500, quantity: 1 }],
      coupons: [{ type: 'percent', value: 100 }, { type: 'fixed', value: 1 }],
    }),
    { subtotalMinor: 500, discountMinor: 500, totalMinor: 0 },
  );
});

test('percent coupons apply before fixed coupons regardless of order', () => {
  const lines = [{ unitMinor: 1000, quantity: 1 }];
  const expected = { subtotalMinor: 1000, discountMinor: 290, totalMinor: 710 };
  // 1000 - 10% = 900, then - 190 = 710
  assert.deepEqual(
    priceOrder({ lines, coupons: [{ type: 'fixed', value: 190 }, { type: 'percent', value: 10 }] }),
    expected,
  );
  assert.deepEqual(
    priceOrder({ lines, coupons: [{ type: 'percent', value: 10 }, { type: 'fixed', value: 190 }] }),
    expected,
  );
});

test('percent coupons compound on the running total in the given order', () => {
  // 1000 - 50% = 500, - 10% = 450, then fixed 100 and 50 -> 300
  assert.deepEqual(
    priceOrder({
      lines: [{ unitMinor: 1000, quantity: 1 }],
      coupons: [
        { type: 'fixed', value: 100 },
        { type: 'percent', value: 50 },
        { type: 'fixed', value: 50 },
        { type: 'percent', value: 10 },
      ],
    }),
    { subtotalMinor: 1000, discountMinor: 700, totalMinor: 300 },
  );
});

test('percent discounts round half to even', () => {
  // 50 * 5% = 2.5 -> 2 (even); 70 * 5% = 3.5 -> 4 (even); 30 * 5% = 1.5 -> 2
  const price = (unitMinor) =>
    priceOrder({ lines: [{ unitMinor, quantity: 1 }], coupons: [{ type: 'percent', value: 5 }] }).discountMinor;
  assert.equal(price(50), 2);
  assert.equal(price(70), 4);
  assert.equal(price(30), 2);
  // 1 * 50% = 0.5 -> 0 (Math.round would give 1)
  assert.equal(price(1), 0);
});

test('invalid coupons are rejected', () => {
  const lines = [{ unitMinor: 1000, quantity: 1 }];
  const bad = [
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
    null,
  ];
  for (const coupon of bad)
    assert.throws(() => priceOrder({ lines, coupons: [coupon] }), /invalid_coupon/, JSON.stringify(coupon));
  // a later invalid coupon rejects the whole order
  assert.throws(
    () => priceOrder({ lines, coupons: [{ type: 'percent', value: 10 }, { type: 'fixed', value: -5 }] }),
    /invalid_coupon/,
  );
});

test('boundary coupon values are accepted', () => {
  const lines = [{ unitMinor: 1000, quantity: 1 }];
  assert.equal(priceOrder({ lines, coupons: [{ type: 'percent', value: 1 }] }).totalMinor, 990);
  assert.equal(priceOrder({ lines, coupons: [{ type: 'percent', value: 100 }] }).totalMinor, 0);
  assert.equal(priceOrder({ lines, coupons: [{ type: 'fixed', value: 1 }] }).totalMinor, 999);
});

test('invalid orders are rejected', () => {
  for (const lines of [
    undefined,
    [],
    [null],
    [{ unitMinor: -1, quantity: 1 }],
    [{ unitMinor: 1.5, quantity: 1 }],
    [{ unitMinor: 100, quantity: 0 }],
    [{ unitMinor: 100, quantity: 1.5 }],
  ])
    assert.throws(() => priceOrder({ lines }), /invalid_order/, JSON.stringify(lines));
});
