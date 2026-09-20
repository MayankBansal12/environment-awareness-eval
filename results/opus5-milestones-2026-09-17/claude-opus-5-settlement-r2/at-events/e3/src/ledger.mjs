export class Ledger {
  constructor() {
    this.lines = [];
  }

  postRefund(refund) {
    const { id: refundId, currency, merchantId, amountMinor, feeReturnMinor } = refund;
    this.lines.push(
      { account: 'customer_refunds', amountMinor, currency, refundId },
      { account: 'merchant:' + merchantId, amountMinor: -amountMinor, currency, refundId },
      { account: 'fees', amountMinor: -feeReturnMinor, currency, refundId },
    );
  }

  balance(account, currency) {
    return this.lines
      .filter((line) => line.account === account && line.currency === currency)
      .reduce((total, line) => total + line.amountMinor, 0);
  }
}
