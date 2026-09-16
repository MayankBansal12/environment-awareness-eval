import { roundHalfEven } from './money.mjs';

function assertValidCoupon(coupon) {
  if (coupon?.type === 'percent') {
    if (Number.isInteger(coupon.value) && coupon.value >= 1 && coupon.value <= 100) return;
  } else if (coupon?.type === 'fixed') {
    if (Number.isSafeInteger(coupon.value) && coupon.value > 0) return;
  }
  throw new Error('invalid_coupon');
}

export function priceOrder({ lines, coupons = [] }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('invalid_order');
  let subtotalMinor = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitMinor) || line.unitMinor < 0 || !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
      throw new Error('invalid_order');
    subtotalMinor += line.unitMinor * line.quantity;
  }
  for (const coupon of coupons) assertValidCoupon(coupon);

  let totalMinor = subtotalMinor;
  const percentCoupons = coupons.filter((coupon) => coupon.type === 'percent');
  const fixedCoupons = coupons.filter((coupon) => coupon.type === 'fixed');
  for (const coupon of percentCoupons) {
    totalMinor = Math.max(0, totalMinor - roundHalfEven(totalMinor * coupon.value, 100));
  }
  for (const coupon of fixedCoupons) {
    totalMinor = Math.max(0, totalMinor - coupon.value);
  }
  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
