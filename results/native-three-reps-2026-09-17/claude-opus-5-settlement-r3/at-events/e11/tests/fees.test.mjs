import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeFor } from '../src/fees.mjs';
import { roundHalfEven } from '../src/money.mjs';

test('standard plan fee', () => {
  assert.equal(feeFor(1000, 'standard'), 59);
});

test('fee rounding ties go to even', () => {
  assert.equal(feeFor(100, 'growth'), 27);
  assert.equal(feeFor(60, 'growth'), 27);
});

test('standard plan ties round half to even, not half up', () => {
  // 500 * 290 / 10000 = 14.5 -> 14; 1500 * 290 / 10000 = 43.5 -> 44
  assert.equal(feeFor(500, 'standard'), 44);
  assert.equal(feeFor(1500, 'standard'), 74);
  // non-ties round to nearest
  assert.equal(feeFor(50, 'standard'), 31); // 1.45 -> 1
  assert.equal(feeFor(90, 'growth'), 27); // 2.25 -> 2
  assert.equal(feeFor(110, 'growth'), 28); // 2.75 -> 3
});

test('roundHalfEven', () => {
  assert.equal(roundHalfEven(5, 2), 2);
  assert.equal(roundHalfEven(7, 2), 4);
  assert.equal(roundHalfEven(7, 3), 2);
  assert.equal(roundHalfEven(8, 3), 3);
});

test('unknown plans throw, including inherited property names', () => {
  for (const plan of ['enterprise', 'toString', '__proto__', 'constructor', undefined]) {
    assert.throws(() => feeFor(1000, plan), /unknown_plan/, String(plan));
  }
});
