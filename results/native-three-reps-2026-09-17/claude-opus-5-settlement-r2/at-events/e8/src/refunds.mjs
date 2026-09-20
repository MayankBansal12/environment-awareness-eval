import { feeFor } from './fees.mjs';
import { sum } from './money.mjs';

export const REFUND_WINDOW_MS = 30 * 86_400_000;

function validString(value) {
  return typeof value === 'string' && value.length > 0;
}

export class RefundBook {
  constructor(charges, ledger, clock = () => Date.now()) {
    this.charges = new Map(charges.map((charge) => [charge.id, charge]));
    this.ledger = ledger;
    this.clock = clock;
    this.refunds = [];
    this.byKey = new Map();
  }

  refund(request) {
    const { merchantId, chargeId, amountMinor, idempotencyKey } = request ?? {};
    if (
      !validString(merchantId) ||
      !validString(chargeId) ||
      !validString(idempotencyKey) ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor <= 0
    )
      throw new Error('invalid_refund');
    const charge = this.charges.get(chargeId);
    if (!charge || charge.merchantId !== merchantId) throw new Error('charge_not_found');
    if (charge.status !== 'captured') throw new Error('charge_not_captured');

    // Keys are scoped per merchant; JSON encoding keeps the composite key unambiguous.
    const key = JSON.stringify([merchantId, idempotencyKey]);
    const prior = this.byKey.get(key);
    if (prior) return structuredClone(prior);

    const now = this.clock();
    if (now - charge.capturedAt > REFUND_WINDOW_MS) throw new Error('refund_window_expired');

    const previous = this.refunds.filter((refund) => refund.chargeId === chargeId);
    const alreadyRefunded = sum(previous.map((refund) => refund.amountMinor));
    if (alreadyRefunded + amountMinor > charge.amountMinor) throw new Error('refund_exceeds_capture');

    const chargeFee = feeFor(charge.amountMinor, charge.plan);
    const returnedFee = sum(previous.map((refund) => refund.feeReturnMinor));
    const feeReturnMinor =
      alreadyRefunded + amountMinor === charge.amountMinor
        ? chargeFee - returnedFee
        : Math.floor((chargeFee * amountMinor) / charge.amountMinor);

    const refund = {
      id: 'rf_' + (this.refunds.length + 1),
      merchantId,
      chargeId,
      amountMinor,
      feeReturnMinor,
      currency: charge.currency,
      createdAt: now,
    };
    this.refunds.push(refund);
    this.ledger.postRefund(refund);
    this.byKey.set(key, refund);
    return structuredClone(refund);
  }
}
