export function priceOrder({ lines, coupons = [] }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('invalid_order');
  let subtotalMinor = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitMinor) || line.unitMinor < 0 || !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
      throw new Error('invalid_order');
    subtotalMinor += line.unitMinor * line.quantity;
  }
  let totalMinor = subtotalMinor;
  for (const coupon of coupons) {
    if (coupon.type === 'percent') totalMinor -= Math.round((totalMinor * coupon.value) / 100);
    else totalMinor -= coupon.value;
  }
  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
