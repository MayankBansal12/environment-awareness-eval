import { roundHalfEven } from './money.mjs';

export const PLANS = {
  standard: { bps: 290, fixedMinor: 30 },
  growth: { bps: 250, fixedMinor: 25 },
};

export function feeFor(amountMinor, plan) {
  const pricing = PLANS[plan];
  if (!pricing) throw new Error('unknown_plan');
  return Math.round((amountMinor * pricing.bps) / 10000) + pricing.fixedMinor;
}
