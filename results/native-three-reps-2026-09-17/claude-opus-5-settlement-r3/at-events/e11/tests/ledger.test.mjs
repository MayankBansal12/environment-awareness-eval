import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.mjs';
import { RefundBook } from '../src/refunds.mjs';

test('refund lines are balanced and the merchant keeps the returned fee', () => {
  const ledger = new Ledger();
  ledger.postRefund({ id: 'rf_1', merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 400, feeReturnMinor: 23, currency: 'USD', createdAt: 0 });
  assert.deepEqual(ledger.lines, [
    { account: 'customer_refunds', amountMinor: 400, currency: 'USD', refundId: 'rf_1' },
    { account: 'merchant:m_1', amountMinor: -377, currency: 'USD', refundId: 'rf_1' },
    { account: 'fees', amountMinor: -23, currency: 'USD', refundId: 'rf_1' },
  ]);
  assert.equal(ledger.lines.reduce((total, line) => total + line.amountMinor, 0), 0);
});

test('balances reconcile across refunds and currencies', () => {
  const ledger = new Ledger();
  const b = new RefundBook(
    [
      { id: 'ch_1', merchantId: 'm_1', amountMinor: 1000, currency: 'USD', plan: 'standard', status: 'captured', capturedAt: 0 },
      { id: 'ch_2', merchantId: 'm_1', amountMinor: 2000, currency: 'EUR', plan: 'growth', status: 'captured', capturedAt: 0 },
    ],
    ledger,
    () => 1,
  );
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 333, idempotencyKey: 'a' });
  b.refund({ merchantId: 'm_1', chargeId: 'ch_1', amountMinor: 667, idempotencyKey: 'b' });
  b.refund({ merchantId: 'm_1', chargeId: 'ch_2', amountMinor: 500, idempotencyKey: 'c' });
  assert.equal(ledger.balance('customer_refunds', 'USD'), 1000);
  assert.equal(ledger.balance('fees', 'USD'), -59);
  assert.equal(ledger.balance('merchant:m_1', 'USD'), -941);
  // EUR fee on 2000 growth = 50 + 25 = 75; 500/2000 -> floor(18.75) = 18
  assert.equal(ledger.balance('customer_refunds', 'EUR'), 500);
  assert.equal(ledger.balance('fees', 'EUR'), -18);
  assert.equal(ledger.balance('merchant:m_1', 'EUR'), -482);
  const byRefund = Map.groupBy(ledger.lines, (line) => line.refundId);
  for (const lines of byRefund.values()) assert.equal(lines.reduce((t, l) => t + l.amountMinor, 0), 0);
});
