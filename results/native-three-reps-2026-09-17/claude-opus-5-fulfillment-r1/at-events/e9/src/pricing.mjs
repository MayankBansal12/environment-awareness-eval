import { roundHalfEven } from './money.mjs';

const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

function validCoupon(coupon) {
  if (coupon === null || typeof coupon !== 'object') return false;
  if (coupon.type === 'percent')
    return Number.isInteger(coupon.value) && coupon.value >= 1 && coupon.value <= 100;
  if (coupon.type === 'fixed') return isPositiveSafeInteger(coupon.value);
  return false;
}

/** roundHalfEven(total * value, 100) without losing precision on large totals. */
function percentOf(totalMinor, value) {
  const product = totalMinor * value;
  if (Number.isSafeInteger(product)) return roundHalfEven(product, 100);
  const big = BigInt(totalMinor) * BigInt(value);
  let quotient = big / 100n;
  const twice = 2n * (big - quotient * 100n);
  if (twice > 100n || (twice === 100n && quotient % 2n === 1n)) quotient += 1n;
  return Number(quotient);
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
    if (!Number.isSafeInteger(subtotalMinor)) throw new Error('invalid_order');
  }

  if (!Array.isArray(coupons) || !coupons.every(validCoupon)) throw new Error('invalid_coupon');

  let totalMinor = subtotalMinor;
  for (const coupon of coupons)
    if (coupon.type === 'percent') totalMinor -= percentOf(totalMinor, coupon.value);
  for (const coupon of coupons)
    if (coupon.type === 'fixed') totalMinor -= coupon.value;
  totalMinor = Math.max(0, totalMinor);

  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
