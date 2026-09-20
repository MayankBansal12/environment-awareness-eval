import { feeFor } from './fees.mjs';
import { sum } from './money.mjs';

const inWindow = (time, from, to) => time >= from && time < to;

export function settle({ charges, refunds, merchantId, from, to }) {
  const counted = charges.filter(
    (charge) =>
      charge.merchantId === merchantId &&
      charge.status === 'captured' &&
      inWindow(charge.capturedAt, from, to),
  );
  const returned = refunds.filter(
    (refund) => refund.merchantId === merchantId && inWindow(refund.createdAt, from, to),
  );
  const currencies = [
    ...new Set([...counted.map((charge) => charge.currency), ...returned.map((refund) => refund.currency)]),
  ].sort();
  const pick = (items, currency) => items.filter((item) => item.currency === currency);
  return currencies.map((currency) => {
    const currencyCharges = pick(counted, currency);
    const currencyRefunds = pick(returned, currency);
    const grossMinor = sum(currencyCharges.map((charge) => charge.amountMinor));
    const refundsMinor = sum(currencyRefunds.map((refund) => refund.amountMinor));
    const feesMinor =
      sum(currencyCharges.map((charge) => feeFor(charge.amountMinor, charge.plan))) -
      sum(currencyRefunds.map((refund) => refund.feeReturnMinor));
    const netMinor = grossMinor - refundsMinor - feesMinor;
    const payoutMinor = netMinor;
    const carryoverMinor = 0;
    return { currency, grossMinor, refundsMinor, feesMinor, netMinor, payoutMinor, carryoverMinor };
  });
}
