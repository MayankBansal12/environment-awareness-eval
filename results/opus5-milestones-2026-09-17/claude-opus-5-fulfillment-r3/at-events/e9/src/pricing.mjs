import { roundHalfEven } from './money.mjs';

const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

function validateLine(line) {
  if (
    line === null ||
    typeof line !== 'object' ||
    !Number.isSafeInteger(line.unitMinor) ||
    line.unitMinor < 0 ||
    !isPositiveSafeInteger(line.quantity)
  )
    throw new Error('invalid_order');
}

function validateCoupon(coupon) {
  if (coupon === null || typeof coupon !== 'object') throw new Error('invalid_coupon');
  if (coupon.type === 'percent') {
    if (!Number.isInteger(coupon.value) || coupon.value < 1 || coupon.value > 100)
      throw new Error('invalid_coupon');
  } else if (coupon.type === 'fixed') {
    if (!isPositiveSafeInteger(coupon.value)) throw new Error('invalid_coupon');
  } else {
    throw new Error('invalid_coupon');
  }
}

export function priceOrder({ lines, coupons = [] }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('invalid_order');
  let subtotalMinor = 0;
  for (const line of lines) {
    validateLine(line);
    subtotalMinor += line.unitMinor * line.quantity;
  }
  if (!Array.isArray(coupons)) throw new Error('invalid_coupon');
  // Validate every coupon before applying any of them.
  coupons.forEach(validateCoupon);

  let totalMinor = subtotalMinor;
  // Percent coupons first, in the given order, on the running total.
  for (const coupon of coupons)
    if (coupon.type === 'percent') totalMinor -= roundHalfEven(totalMinor * coupon.value, 100);
  // Then fixed coupons.
  for (const coupon of coupons) if (coupon.type === 'fixed') totalMinor -= coupon.value;
  // The total never goes below zero.
  totalMinor = Math.max(0, totalMinor);

  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
