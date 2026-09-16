import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefundBook } from '../src/refunds.mjs';
import { Ledger } from '../src/ledger.mjs';

const DAY = 86_400_000;
const charges = () => [
  { id: 'ch_1', merchantId: 'm_1', amountMinor: 1000, currency: 'USD', plan: 'standard', status: 'captured', capturedAt: 10 * DAY },
  { id: 'ch_2', merchantId: 'm_2', amountMinor: 500, currency: 'USD', plan: 'growth', status: 'captured', capturedAt: 10 * DAY },
  { id: 'ch_3', merchantId: 'm_1', amountMinor: 700, currency: 'EUR', plan: 'standard', status: 'pending', capturedAt: 10 * DAY },
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

test('capture limit counts every previous refund, not just the last one', () => {
  const b = book();
  for (let i = 0; i < 4; i++) b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 250, idempotencyKey: 'k' + i });
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 1, idempotencyKey: 'k4' }),
    /refund_exceeds_capture/,
  );
  assert.throws(
    () => book().refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 1001, idempotencyKey: 'x' }),
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

test('replaying a key posts nothing and returns the original refund', () => {
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => 11 * DAY);
  const first = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k' });
  const lines = ledger.lines.length;
  const replay = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 300, idempotencyKey: 'k' });
  assert.deepEqual(replay, first);
  assert.equal(ledger.lines.length, lines);
  const next = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 900, idempotencyKey: 'k2' });
  assert.equal(next.id, 'rf_2');
});

test('fully refunding a charge returns the whole fee', () => {
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => 11 * DAY);
  const r1 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 333, idempotencyKey: 'a' });
  const r2 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 333, idempotencyKey: 'b' });
  const r3 = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 334, idempotencyKey: 'c' });
  assert.deepEqual([r1.feeReturnMinor, r2.feeReturnMinor, r3.feeReturnMinor], [19, 19, 21]);
  assert.equal(ledger.balance('fees', 'USD'), -59);

  const single = book().refund({ merchantId: 'm_2', chargeId: 'ch_2', amountMinor: 500, idempotencyKey: 'full' });
  assert.equal(single.feeReturnMinor, 37); // growth fee on 500: 12.5 -> 12 + 25
});

test('refund shape, ids, clock and copies', () => {
  const b = book();
  const refund = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, idempotencyKey: 'k1' });
  assert.deepEqual(refund, {
    id: 'rf_1', merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, feeReturnMinor: 23, currency: 'USD', createdAt: 11 * DAY,
  });
  refund.amountMinor = 1;
  refund.feeReturnMinor = 0;
  assert.equal(b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 1, idempotencyKey: 'k1' }).amountMinor, 400);
  // mutation must not free up capture headroom
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 601, idempotencyKey: 'k2' }),
    /refund_exceeds_capture/,
  );
});

test('validation and charge checks', () => {
  const b = book();
  const ok = { merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k' };
  for (const bad of [{ merchantId: '' }, { chargeId: 5 }, { idempotencyKey: '' }, { amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1.5 }, { amountMinor: 2 ** 53 }]) {
    assert.throws(() => b.refund({ ...ok, ...bad }), /invalid_refund/);
  }
  assert.throws(() => b.refund(), /invalid_refund/);
  assert.throws(() => b.refund({ ...ok, chargeId: 'ch_missing' }), /charge_not_found/);
  assert.throws(() => b.refund({ ...ok, merchantId: 'm_2' }), /charge_not_found/);
  assert.throws(() => b.refund({ ...ok, chargeId: 'ch_3' }), /charge_not_captured/);
});

test('refunds are rejected more than 30 days after capture', () => {
  let now = 40 * DAY; // exactly 30 days after capturedAt
  const ledger = new Ledger();
  const b = new RefundBook(charges(), ledger, () => now);
  const atLimit = b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k1' });
  assert.equal(atLimit.createdAt, 40 * DAY);

  now = 40 * DAY + 1;
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k2' }),
    /refund_window_expired/,
  );
  // window check runs before the capture limit
  assert.throws(
    () => b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 5000, idempotencyKey: 'k3' }),
    /refund_window_expired/,
  );
  // replay of an existing refund still returns it after the window
  assert.deepEqual(b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 100, idempotencyKey: 'k1' }), atLimit);
  assert.equal(ledger.lines.length, 3);
});
