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
