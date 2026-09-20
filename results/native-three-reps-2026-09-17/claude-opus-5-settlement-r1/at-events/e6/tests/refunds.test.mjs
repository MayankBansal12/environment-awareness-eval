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

test('cumulative refunds cannot exceed capture (three partials)', () => {
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => 11 * DAY);
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, idempotencyKey: 'k1' });
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, idempotencyKey: 'k2' });
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 300, idempotencyKey: 'k3' }),
    /refund_exceeds_capture/,
  );
  assert.equal(ledger.balance('customer_refunds', 'USD'), 800);
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 200, idempotencyKey: 'k4' });
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 1, idempotencyKey: 'k5' }),
    /refund_exceeds_capture/,
  );
});

test('fully refunding a charge returns the whole fee', () => {
  const b = book();
  // fee for 1000 standard = 29 + 30 = 59; floor(59/3) = 19 each for the first two thirds.
  const r1 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 333, idempotencyKey: 'k1' });
  const r2 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 333, idempotencyKey: 'k2' });
  const r3 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 334, idempotencyKey: 'k3' });
  assert.equal(r1.feeReturnMinor, 19);
  assert.equal(r2.feeReturnMinor, 19);
  assert.equal(r3.feeReturnMinor, 59 - 38);
  const full = book().refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 1000, idempotencyKey: 'k' });
  assert.equal(full.feeReturnMinor, 59);
});

test('same idempotency key from another merchant is independent; replays post nothing', () => {
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => 11 * DAY);
  const first = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'same' });
  const other = b.refund({ merchantId: 'm_2', chargeId: 'ch_2', amountMinor: 50, idempotencyKey: 'same' });
  assert.equal(other.id, 'rf_2');
  assert.equal(other.merchantId, 'm_2');
  assert.equal(other.amountMinor, 50);
  const lines = ledger.lines.length;
  const replay = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 999, idempotencyKey: 'same' });
  assert.deepEqual(replay, first);
  assert.equal(ledger.lines.length, lines);
});

test('returned refunds are copies', () => {
  const b = book();
  const r = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k' });
  r.amountMinor = 1;
  assert.equal(b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k' }).amountMinor, 100);
});

test('ledger lines for each refund balance to zero', () => {
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => 11 * DAY);
  const r = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, idempotencyKey: 'k1' });
  const lines = ledger.lines.filter((line) => line.refundId === r.id);
  assert.equal(lines.reduce((t, l) => t + l.amountMinor, 0), 0);
  assert.equal(ledger.balance('customer_refunds', 'USD'), 400);
  assert.equal(ledger.balance('merchant:m_1', 'USD'), -(400 - 23));
  assert.equal(ledger.balance('fees', 'USD'), -23);
});

test('refund window: exactly 30 days allowed, later rejected', () => {
  const captured = 10 * DAY;
  let now = captured + 30 * DAY;
  const b = new RefundBook(charges(), new Ledger(), () => now);
  const ok = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k1' });
  assert.equal(ok.createdAt, captured + 30 * DAY);
  now = captured + 30 * DAY + 1;
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k2' }),
    /refund_window_expired/,
  );
  // Idempotent replay still returns the existing refund after the window closes.
  assert.deepEqual(b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k1' }), ok);
});

test('refund window is checked before the capture limit', () => {
  const b = new RefundBook(charges(), new Ledger(), () => 10 * DAY + 31 * DAY);
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 5000, idempotencyKey: 'k' }),
    /refund_window_expired/,
  );
});

test('rejects non-captured and foreign charges', () => {
  const b = new RefundBook(
    [...charges(), { id: 'ch_p', merchantId: 'm_1', amountMinor: 100, currency: 'USD', plan: 'standard', status: 'pending', capturedAt: 10 * DAY }],
    new Ledger(),
    () => 11 * DAY,
  );
  assert.throws(() => b.refund({ merchantId: 'm_1', chargeId: 'ch_p', amountMinor: 10, idempotencyKey: 'k' }), /charge_not_captured/);
  assert.throws(() => b.refund({ merchantId: 'm_1', chargeId: 'ch_2', amountMinor: 10, idempotencyKey: 'k' }), /charge_not_found/);
  assert.throws(() => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 0, idempotencyKey: 'k' }), /invalid_refund/);
});
