import { roundHalfEven } from './money.mjs';

const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

function validateCoupon(coupon) {
  if (coupon === null || typeof coupon !== 'object') throw new Error('invalid_coupon');
  if (coupon.type === 'percent' && Number.isInteger(coupon.value) && coupon.value >= 1 && coupon.value <= 100)
    return;
  if (coupon.type === 'fixed' && isPositiveSafeInteger(coupon.value)) return;
  throw new Error('invalid_coupon');
}

export function priceOrder({ lines, coupons = [] }) {
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

  if (!Array.isArray(coupons)) throw new Error('invalid_coupon');
  // Validate every coupon before applying any, so a bad coupon never yields a partial price.
  coupons.forEach(validateCoupon);

  let totalMinor = subtotalMinor;
  // All percent coupons first, in the given order, each on the running total.
  for (const coupon of coupons) {
    if (coupon.type === 'percent') totalMinor -= roundHalfEven(totalMinor * coupon.value, 100);
  }
  // Then fixed coupons.
  for (const coupon of coupons) {
    if (coupon.type === 'fixed') totalMinor -= coupon.value;
  }
  totalMinor = Math.max(0, totalMinor);

  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
