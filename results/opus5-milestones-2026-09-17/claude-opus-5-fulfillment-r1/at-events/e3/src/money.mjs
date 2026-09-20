/** Integer division with round-half-to-even. Both arguments are non-negative integers. */
export function roundHalfEven(numerator, denominator) {
  const quotient = Math.floor(numerator / denominator);
  const twice = 2 * (numerator - quotient * denominator);
  if (twice > denominator || (twice === denominator && quotient % 2 === 1)) return quotient + 1;
  return quotient;
}
