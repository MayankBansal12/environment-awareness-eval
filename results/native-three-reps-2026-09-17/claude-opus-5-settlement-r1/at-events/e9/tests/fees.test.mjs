import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeFor } from '../src/fees.mjs';

test('standard plan fee', () => {
  assert.equal(feeFor(1000, 'standard'), 59);
});

test('fee rounding ties go to even', () => {
  assert.equal(feeFor(100, 'growth'), 27);
  assert.equal(feeFor(60, 'growth'), 27);
});

test('fee rounding uses half-even, not half-up', () => {
  // 250 bps of 300 = 7.5 -> 8 (even); 250 bps of 500 = 12.5 -> 12 (even).
  assert.equal(feeFor(300, 'growth'), 33);
  assert.equal(feeFor(500, 'growth'), 37);
  // 290 bps of 50 = 1.45 -> 1; non-tie values round to nearest.
  assert.equal(feeFor(50, 'standard'), 31);
});

test('unknown plans throw', () => {
  assert.throws(() => feeFor(1000, 'enterprise'), /unknown_plan/);
  assert.throws(() => feeFor(1000, 'toString'), /unknown_plan/);
});
