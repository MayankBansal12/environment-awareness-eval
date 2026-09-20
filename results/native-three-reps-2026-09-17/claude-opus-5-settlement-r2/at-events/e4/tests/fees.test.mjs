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
  // 1050 * 290 / 10000 = 30.45 -> 30; 1500 * 290 / 10000 = 43.5 -> 44 (even); 500 * 250 / 10000 = 12.5 -> 12 (even)
  assert.equal(feeFor(1050, 'standard'), 60);
  assert.equal(feeFor(1500, 'standard'), 74);
  assert.equal(feeFor(500, 'growth'), 37);
  assert.equal(feeFor(300, 'growth'), 33); // 7.5 -> 8 (even)
});

test('unknown plan throws', () => {
  assert.throws(() => feeFor(1000, 'enterprise'), /unknown_plan/);
});
