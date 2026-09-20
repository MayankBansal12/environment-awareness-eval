import { roundHalfEven } from './money.mjs';

export const PLANS = {
  standard: { bps: 290, fixedMinor: 30 },
  growth: { bps: 250, fixedMinor: 25 },
};

export function feeFor(amountMinor, plan) {
  const pricing = Object.hasOwn(PLANS, plan) ? PLANS[plan] : undefined;
  if (!pricing) throw new Error('unknown_plan');
  return roundHalfEven(amountMinor * pricing.bps, 10000) + pricing.fixedMinor;
}
