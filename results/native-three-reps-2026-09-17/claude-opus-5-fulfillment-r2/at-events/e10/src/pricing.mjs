import { roundHalfEven } from './money.mjs';

const isObject = (value) => typeof value === 'object' && value !== null;

function validateCoupon(coupon) {
  if (!isObject(coupon)) throw new Error('invalid_coupon');
  const { type, value } = coupon;
  if (type === 'percent' && Number.isSafeInteger(value) && value >= 1 && value <= 100) return;
  if (type === 'fixed' && Number.isSafeInteger(value) && value > 0) return;
  throw new Error('invalid_coupon');
}

export function priceOrder({ lines, coupons = [] } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('invalid_order');
  let subtotalMinor = 0;
  for (const line of lines) {
    if (
      !isObject(line) ||
      !Number.isSafeInteger(line.unitMinor) ||
      line.unitMinor < 0 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0
    )
      throw new Error('invalid_order');
    subtotalMinor += line.unitMinor * line.quantity;
  }

  if (!Array.isArray(coupons)) throw new Error('invalid_coupon');
  coupons.forEach(validateCoupon);

  let totalMinor = subtotalMinor;
  for (const coupon of coupons)
    if (coupon.type === 'percent') totalMinor -= roundHalfEven(totalMinor * coupon.value, 100);
  for (const coupon of coupons) if (coupon.type === 'fixed') totalMinor -= coupon.value;
  totalMinor = Math.max(0, totalMinor);

  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
