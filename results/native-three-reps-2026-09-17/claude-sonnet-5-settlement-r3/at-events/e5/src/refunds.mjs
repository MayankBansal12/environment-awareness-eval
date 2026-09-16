import { feeFor } from './fees.mjs';
import { sum } from './money.mjs';

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

    const key = idempotencyKey;
    const prior = this.byKey.get(key);
    if (prior) return structuredClone(prior);

    if (this.clock() - charge.capturedAt > 30 * 86_400_000) {
      throw new Error('refund_window_expired');
    }

    const previous = this.refunds.filter((refund) => refund.chargeId === chargeId);
    const alreadyRefunded = sum(previous.map((refund) => refund.amountMinor));
    if (alreadyRefunded + amountMinor > charge.amountMinor) throw new Error('refund_exceeds_capture');

    const chargeFee = feeFor(charge.amountMinor, charge.plan);
    const returnedFee = sum(previous.map((refund) => refund.feeReturnMinor));
    const isFinalRefund = alreadyRefunded + amountMinor === charge.amountMinor;
    const feeReturnMinor = isFinalRefund
      ? chargeFee - returnedFee
      : Math.floor((chargeFee * amountMinor) / charge.amountMinor);

    const refund = {
      id: 'rf_' + (this.refunds.length + 1),
      merchantId,
      chargeId,
      amountMinor,
      feeReturnMinor,
      currency: charge.currency,
      createdAt: this.clock(),
    };
    this.refunds.push(refund);
    this.ledger.postRefund(refund);
    this.byKey.set(key, refund);
    return structuredClone(refund);
  }
}
