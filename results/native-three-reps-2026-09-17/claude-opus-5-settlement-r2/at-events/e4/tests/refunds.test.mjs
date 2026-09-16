import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefundBook } from '../src/refunds.mjs';
import { Ledger } from '../src/ledger.mjs';

const DAY = 86_400_000;
const charges = () => [
  { id: 'ch_1', merchantId: 'm_1', amountMinor: 1000, currency: 'USD', plan: 'standard', status: 'captured', capturedAt: 10 * DAY },
  { id: 'ch_2', merchantId: 'm_2', amountMinor: 500, currency: 'USD', plan: 'growth', status: 'captured', capturedAt: 10 * DAY },
];
const book = () => new RefundBook(charges(), new Ledger(), () => 11 * DAY);

test('partial refund returns proportional fee', () => {
  const refund = book().refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, idempotencyKey: 'k1' });
  assert.equal(refund.amountMinor, 400);
  assert.equal(refund.feeReturnMinor, 23);
});

test('refunds cannot exceed the captured amount', () => {
  const b = book();
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 600, idempotencyKey: 'k1' });
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 300, idempotencyKey: 'k2' });
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 200, idempotencyKey: 'k3' }),
    /refund_exceeds_capture/,
  );
});

test('idempotency keys are merchant scoped', () => {
  const b = book();
  const first = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'same' });
  const other = b.refund({ merchantId: 'm_2', chargeId: 'ch_2', amountMinor: 50, idempotencyKey: 'same' });
  assert.equal(other.chargeId, 'ch_2');
  assert.deepEqual(b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 999, idempotencyKey: 'same' }), first);
});

test('cumulative refunds cannot exceed the captured amount', () => {
  const b = book();
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, idempotencyKey: 'k1' });
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, idempotencyKey: 'k2' });
  // 400 + 400 + 300 = 1100 > 1000, even though the last refund alone plus 300 fits.
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 300, idempotencyKey: 'k3' }),
    /refund_exceeds_capture/,
  );
  const last = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 200, idempotencyKey: 'k4' });
  assert.equal(last.amountMinor, 200);
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 1, idempotencyKey: 'k5' }),
    /refund_exceeds_capture/,
  );
});

test('same idempotency key for a different merchant is an independent refund', () => {
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => 11 * DAY);
  const first = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'same' });
  const other = b.refund({ merchantId: 'm_2', chargeId: 'ch_2', amountMinor: 50, idempotencyKey: 'same' });
  assert.notEqual(other.id, first.id);
  assert.equal(other.merchantId, 'm_2');
  assert.equal(other.amountMinor, 50);
  assert.equal(ledger.balance('customer_refunds', 'USD'), 150);
  // Replay for the original merchant posts nothing.
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 999, idempotencyKey: 'same' });
  assert.equal(ledger.balance('customer_refunds', 'USD'), 150);
});

test('fully refunding a charge in parts returns the whole fee', () => {
  const b = book();
  // Fee for 1000 standard = 59. Three refunds of 333/333/334.
  const r1 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 333, idempotencyKey: 'a' });
  const r2 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 333, idempotencyKey: 'b' });
  const r3 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 334, idempotencyKey: 'c' });
  assert.equal(r1.feeReturnMinor, 19);
  assert.equal(r2.feeReturnMinor, 19);
  assert.equal(r3.feeReturnMinor, 21);
  assert.equal(r1.feeReturnMinor + r2.feeReturnMinor + r3.feeReturnMinor, 59);
});

test('ledger lines for a refund balance to zero', () => {
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => 11 * DAY);
  const r = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, idempotencyKey: 'k1' });
  assert.equal(ledger.balance('customer_refunds', 'USD'), 400);
  assert.equal(ledger.balance('merchant:m_1', 'USD'), -(400 - r.feeReturnMinor));
  assert.equal(ledger.balance('fees', 'USD'), -r.feeReturnMinor);
  const lines = ledger.lines.filter((line) => line.refundId === r.id);
  assert.equal(lines.reduce((t, line) => t + line.amountMinor, 0), 0);
});

test('returned refunds are copies', () => {
  const b = book();
  const r = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k1' });
  r.amountMinor = 1;
  assert.equal(b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k1' }).amountMinor, 100);
});

test('refunds more than 30 days after capture are rejected', () => {
  let now = 40 * DAY; // capturedAt is 10 * DAY
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => now);
  assert.equal(
    b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'edge' }).createdAt,
    40 * DAY,
  );
  now = 40 * DAY + 1;
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'late' }),
    /refund_window_expired/,
  );
  // Replay of an existing refund still returns it after the window.
  assert.equal(b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'edge' }).id, 'rf_1');
  // Window check comes before the capture limit.
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 5000, idempotencyKey: 'big' }),
    /refund_window_expired/,
  );
  assert.equal(ledger.balance('customer_refunds', 'USD'), 100);
});
