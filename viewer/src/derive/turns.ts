import type { ActionRow, MarkerRow, PhaseKind, RunBundle } from './model.js';
export type ReasoningState = 'present' | 'redacted' | 'none_returned' | 'not_captured';
export interface TurnRow {
  kind: 'turn';
  decisionIndex: number;
  seq: number;
  narration: string;
  hasNarration: boolean;
  reasoning: string | null;
  reasoningState: ReasoningState;
  reasoningTokens: number | null;
  actions: ActionRow[];
  phase: PhaseKind | null;
  headline: string;
  targets: string;
  isFinal: boolean;
}
export type ActivityRow = TurnRow | MarkerRow;
export function turnRowsOf(run: RunBundle, actions: ActionRow[]): TurnRow[] {
  return run.trace
    .filter((e) => e.type === 'input')
    .map((e) => {
      const message = run.outputs[e.decision];
      const blocks = message?.blocks;
      const narration = blocks
        ? blocks
            .filter((b) => b.kind === 'text')
            .map((b) => b.text)
            .join('\n')
        : (message?.text ?? '');
      const thinking = blocks?.filter((b) => b.kind === 'thinking') ?? [];
      const reasoning = thinking.map((b) => b.text).join('\n') || null;
      const calls = actions.filter((a) => a.decisionIndex === e.decision);
      const output = run.trace.find(
        (t) => t.type === 'output' && t.decision === e.decision,
      );
      return {
        kind: 'turn',
        decisionIndex: e.decision,
        seq: e.seq,
        narration,
        hasNarration: !!narration,
        reasoning,
        reasoningState: reasoning
          ? 'present'
          : !blocks
            ? 'not_captured'
            : thinking.some((b) => b.providerRedacted)
              ? 'redacted'
              : 'none_returned',
        reasoningTokens:
          output?.type === 'output' ? (output.usage?.reasoning ?? null) : null,
        actions: calls,
        phase: calls[0]?.phase ?? null,
        headline:
          calls.length === 1
            ? calls[0]!.label
            : calls.length
              ? `${calls.length} tool calls`
              : output?.type === 'output'
                ? output.stopReason
                : 'Output not captured',
        targets: [...new Set(calls.map((a) => a.path).filter(Boolean))].join(', '),
        isFinal:
          output?.type === 'output' && output.stopReason === 'stop' && calls.length === 0,
      };
    });
}
export const activityRowsOf = (turns: TurnRow[], markers: MarkerRow[]): ActivityRow[] =>
  [...turns, ...markers].sort((a, b) => a.seq - b.seq);
export function decisionRangeOf(trace: RunBundle['trace']) {
  const decisions = trace.filter((e) => e.type === 'input').map((e) => e.decision);
  return { min: decisions[0] ?? 1, max: Math.max(1, ...decisions) };
}
export const finalReportOf = (turns: TurnRow[]) =>
  turns.filter((t) => t.isFinal).at(-1)?.narration ?? '';
