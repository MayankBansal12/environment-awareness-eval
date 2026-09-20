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

const line = (unitMinor, quantity = 1) => ({ unitMinor, quantity });

test('total never goes below zero', () => {
  assert.deepEqual(priceOrder({ lines: [line(500)], coupons: [{ type: 'fixed', value: 800 }] }), {
    subtotalMinor: 500,
    discountMinor: 500,
    totalMinor: 0,
  });
  assert.deepEqual(
    priceOrder({ lines: [line(500)], coupons: [{ type: 'percent', value: 100 }, { type: 'fixed', value: 1 }] }),
    { subtotalMinor: 500, discountMinor: 500, totalMinor: 0 },
  );
});

test('percent coupons apply before fixed coupons regardless of order', () => {
  const percent = { type: 'percent', value: 10 };
  const fixed = { type: 'fixed', value: 100 };
  const expected = { subtotalMinor: 1000, discountMinor: 200, totalMinor: 800 };
  assert.deepEqual(priceOrder({ lines: [line(1000)], coupons: [fixed, percent] }), expected);
  assert.deepEqual(priceOrder({ lines: [line(1000)], coupons: [percent, fixed] }), expected);
});

test('percent coupons compound in given order on the running total', () => {
  // 1000 -> -500 = 500 -> -roundHalfEven(500*25,100)=125 -> 375 -> -30 fixed = 345
  assert.deepEqual(
    priceOrder({
      lines: [line(250, 4)],
      coupons: [{ type: 'fixed', value: 30 }, { type: 'percent', value: 50 }, { type: 'percent', value: 25 }],
    }),
    { subtotalMinor: 1000, discountMinor: 655, totalMinor: 345 },
  );
});

test('percent discount rounds half to even', () => {
  // 50 * 5 / 100 = 2.5 -> 2 ; 70 * 5 / 100 = 3.5 -> 4
  assert.equal(priceOrder({ lines: [line(50)], coupons: [{ type: 'percent', value: 5 }] }).totalMinor, 48);
  assert.equal(priceOrder({ lines: [line(70)], coupons: [{ type: 'percent', value: 5 }] }).totalMinor, 66);
  // 30 * 5 / 100 = 1.5 -> 2
  assert.equal(priceOrder({ lines: [line(30)], coupons: [{ type: 'percent', value: 5 }] }).totalMinor, 28);
});

test('percent discount is exact for large totals', () => {
  const unit = Number.MAX_SAFE_INTEGER; // 9007199254740991
  const { totalMinor } = priceOrder({ lines: [line(unit)], coupons: [{ type: 'percent', value: 50 }] });
  // discount = roundHalfEven(unit * 50, 100) = 4503599627370495.5 -> 4503599627370496 (even)
  assert.equal(totalMinor, unit - 4503599627370496);
});

test('invalid coupons throw invalid_coupon', () => {
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
    { value: 10 },
    null,
  ];
  for (const coupon of bad)
    assert.throws(() => priceOrder({ lines: [line(100)], coupons: [coupon] }), /invalid_coupon/, JSON.stringify(coupon));
});

test('invalid orders throw invalid_order', () => {
  for (const lines of [[], undefined, [line(-1)], [line(1.5)], [line(100, 0)], [line(100, 1.5)], [null], [line(2 ** 53)]])
    assert.throws(() => priceOrder({ lines }), /invalid_order/, JSON.stringify(lines));
});
