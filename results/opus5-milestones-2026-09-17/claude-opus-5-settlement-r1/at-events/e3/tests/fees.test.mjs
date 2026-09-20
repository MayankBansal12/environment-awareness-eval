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
