export const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
export const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
export const minutes = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
export const num = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(digits);
export const pct = (p: number | null | undefined) =>
  p === null || p === undefined ? '—' : `${Math.round(p * 100)}%`;
export const cell = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : typeof v === 'boolean'
      ? v
        ? 'yes'
        : 'no'
      : String(v);
