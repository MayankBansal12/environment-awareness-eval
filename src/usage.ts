export interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
  totalTokens: number;
  costUsd: number;
}
export interface UsageTotals {
  calls: number;
  turnCalls: number;
  summaryCalls: number;
  erroredCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costUsd: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /** Largest context sent in one call (input + cache read + cache write). */
  peakContextTokens: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function usageOf(message: unknown): UsageRecord | null {
  const usage = (message as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const cost = (usage['cost'] ?? {}) as Record<string, unknown>;
  return {
    input: num(usage['input']),
    output: num(usage['output']),
    cacheRead: num(usage['cacheRead']),
    cacheWrite: num(usage['cacheWrite']),
    reasoning: typeof usage['reasoning'] === 'number' ? usage['reasoning'] : null,
    totalTokens: num(usage['totalTokens']),
    costUsd: num(cost['total']),
  };
}

export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    turnCalls: 0,
    summaryCalls: 0,
    erroredCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    costUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    peakContextTokens: 0,
  };
}

/** Accumulates every provider call, including retried and compaction calls. */
export class UsageMeter {
  readonly totals = emptyTotals();
  add(message: unknown, purpose: 'turn' | 'summary') {
    const t = this.totals;
    t.calls++;
    if (purpose === 'turn') t.turnCalls++;
    else t.summaryCalls++;
    if ((message as { stopReason?: unknown } | null)?.stopReason === 'error')
      t.erroredCalls++;
    const usage = (message as { usage?: Record<string, unknown> } | null)?.usage;
    const record = usageOf(message);
    if (!record) return record;
    t.input += record.input;
    t.output += record.output;
    t.cacheRead += record.cacheRead;
    t.cacheWrite += record.cacheWrite;
    t.reasoning += record.reasoning ?? 0;
    t.totalTokens += record.totalTokens;
    const cost = (usage?.['cost'] ?? {}) as Record<string, unknown>;
    t.costUsd.input += num(cost['input']);
    t.costUsd.output += num(cost['output']);
    t.costUsd.cacheRead += num(cost['cacheRead']);
    t.costUsd.cacheWrite += num(cost['cacheWrite']);
    t.costUsd.total += num(cost['total']);
    t.peakContextTokens = Math.max(
      t.peakContextTokens,
      record.input + record.cacheRead + record.cacheWrite,
    );
    return record;
  }
}
