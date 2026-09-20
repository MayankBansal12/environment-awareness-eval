import { roundHalfEven } from './money.mjs';

const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

function validateCoupon(coupon) {
  if (coupon === null || typeof coupon !== 'object') throw new Error('invalid_coupon');
  if (coupon.type === 'percent') {
    if (!Number.isInteger(coupon.value) || coupon.value < 1 || coupon.value > 100) throw new Error('invalid_coupon');
  } else if (coupon.type === 'fixed') {
    if (!isPositiveSafeInteger(coupon.value)) throw new Error('invalid_coupon');
  } else {
    throw new Error('invalid_coupon');
  }
}

export function priceOrder({ lines, coupons = [] } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('invalid_order');
  let subtotalMinor = 0;
  for (const line of lines) {
    if (
      line === null ||
      typeof line !== 'object' ||
      !Number.isSafeInteger(line.unitMinor) ||
      line.unitMinor < 0 ||
      !isPositiveSafeInteger(line.quantity)
    )
      throw new Error('invalid_order');
    subtotalMinor += line.unitMinor * line.quantity;
  }
  // Guard against silent float precision loss on absurdly large orders.
  if (!Number.isSafeInteger(subtotalMinor)) throw new Error('invalid_order');

  if (!Array.isArray(coupons)) throw new Error('invalid_coupon');
  coupons.forEach(validateCoupon);

  let totalMinor = subtotalMinor;
  for (const coupon of coupons)
    if (coupon.type === 'percent') totalMinor -= roundHalfEven(totalMinor * coupon.value, 100);
  for (const coupon of coupons)
    if (coupon.type === 'fixed') totalMinor -= coupon.value;
  totalMinor = Math.max(0, totalMinor);

  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
