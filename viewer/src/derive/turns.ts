/**
 * Turn-level activity: one row per model decision, not one per tool call.
 *
 * The existing timeline is action-granular, which is the right altitude for auditing what
 * happened but the wrong one for reading a run as a narrative — a 30-decision run is 90
 * action rows, and the shape of the run disappears into them. A turn row is the unit the
 * model actually chose at: it emitted one assistant message, which issued one batch of
 * tool calls, and the harness then opened exactly one new decision boundary.
 *
 * `decisionIndex` and `turnIndex` are equal across the whole corpus and `batchId` is
 * `turn-<n>`, but actions are grouped by `decisionIndex` alone rather than by any of those
 * identities, so a trace that stops honouring the coincidence still groups correctly.
 *
 * Narration is `assistant_turn.text` verbatim and reasoning is `reasoningText` verbatim.
 * Neither is ever substituted for the other, and neither is ever synthesised from the tool
 * calls: a turn with no recorded narration is reported as having none.
 *
 * Reasoning has three states, not two, and the trace version is what separates them —
 * a trace written before v4 predates capture entirely, so an absent field there says
 * nothing about the model, whereas an absent field in a v4 trace means the provider
 * returned no thinking blocks. `REASONING_CAPTURE_VERSION` is that boundary.
 */

import type { TraceEvent } from '../../../src/trace/schema.js';
import type { ActionRow, MarkerRow, PhaseKind, RunBundle } from './model.js';
import { describeComposition, describeTargets } from './timeline.js';

/** The first trace generation that records `assistant_turn.reasoningText`. */
export const REASONING_CAPTURE_VERSION = 4;

/**
 * Why a turn shows no reasoning. `not_captured` is a fact about the harness that wrote the
 * trace; `none_returned` is a fact about the provider; `redacted` is a fact about a safety
 * filter. Collapsing them would let a reader conclude a model reasoned about nothing when
 * the truth is that nobody recorded it.
 */
export type ReasoningState =
  | 'present'
  | 'redacted'
  | 'none_returned'
  | 'not_captured';

export interface TurnRow {
  kind: 'turn';
  turnIndex: number;
  decisionIndex: number;
  seq: number;
  /** `assistant_turn.text`, verbatim. Usually empty; never substituted. */
  narration: string;
  hasNarration: boolean;
  /** `assistant_turn.reasoningText`, verbatim, or null when there is none to show. */
  reasoning: string | null;
  reasoningState: ReasoningState;
  /** Reasoning tokens billed for this turn, when the provider reported a breakdown. */
  reasoningTokens: number | null;
  stopReason: string;
  /** Tool calls issued by this turn, in assistant source order. */
  actions: ActionRow[];
  /** The phase this turn is mostly about, or null for a turn that called no tools. */
  phase: PhaseKind | null;
  /** e.g. `4 calls · 2 read, 2 ls`, or a single action's own label. */
  headline: string;
  /** e.g. `README, package.json`. Empty when nothing pathlike was touched. */
  targets: string;
  /** The closing turn — the one that produced the final report. */
  isFinal: boolean;
  event: Extract<TraceEvent, { type: 'assistant_turn' }>;
}

export type ActivityRow = TurnRow | MarkerRow;

/** The dominant phase of a batch: most calls wins, ties broken by first occurrence. */
function dominantPhase(actions: readonly ActionRow[]): PhaseKind | null {
  const counts = new Map<PhaseKind, number>();
  for (const action of actions) {
    counts.set(action.phase, (counts.get(action.phase) ?? 0) + 1);
  }
  let best: PhaseKind | null = null;
  let bestCount = 0;
  for (const action of actions) {
    const count = counts.get(action.phase) ?? 0;
    if (count > bestCount) {
      best = action.phase;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A single call reads best as itself; a batch reads best as a census. Restating one
 * action's label as `1 calls · 1 read` would be strictly less informative than `read x.ts`.
 */
function headlineFor(actions: readonly ActionRow[], stopReason: string): string {
  if (actions.length === 0) {
    return stopReason === 'toolUse' ? 'no tool calls settled' : 'final response';
  }
  const only = actions[0];
  if (actions.length === 1 && only !== undefined) return only.label;
  return `${actions.length} calls · ${describeComposition(actions)}`;
}

/**
 * Classifies a turn's reasoning against the generation of the trace it came from.
 * `capturesReasoning` is false for any trace written before v4, where the field could not
 * have been populated regardless of what the model did.
 */
export function reasoningStateOf(
  turn: Pick<
    Extract<TraceEvent, { type: 'assistant_turn' }>,
    'reasoningText' | 'reasoningRedacted'
  >,
  capturesReasoning: boolean,
): ReasoningState {
  if (!capturesReasoning) return 'not_captured';
  const text = turn.reasoningText;
  if (text !== undefined && text.trim() !== '') return 'present';
  if (turn.reasoningRedacted === true) return 'redacted';
  return 'none_returned';
}

/** True when the trace was written by a runner that captures reasoning at all. */
export function capturesReasoning(run: RunBundle): boolean {
  return (run.traceSchemaVersion ?? 0) >= REASONING_CAPTURE_VERSION;
}

/**
 * Builds one row per `assistant_turn`, attaching the actions recorded at the same
 * decision. Rows come back in `seq` order.
 */
export function turnRowsOf(run: RunBundle, actions: readonly ActionRow[]): TurnRow[] {
  const byDecision = new Map<number, ActionRow[]>();
  for (const action of actions) {
    const bucket = byDecision.get(action.decisionIndex);
    if (bucket === undefined) byDecision.set(action.decisionIndex, [action]);
    else bucket.push(action);
  }
  for (const bucket of byDecision.values()) {
    bucket.sort((a, b) => {
      const left = a.siblingOrdinal ?? a.actionIndex;
      const right = b.siblingOrdinal ?? b.actionIndex;
      return left - right || a.actionIndex - b.actionIndex;
    });
  }

  const turns = run.trace.filter(
    (event): event is Extract<TraceEvent, { type: 'assistant_turn' }> =>
      event.type === 'assistant_turn',
  );
  const lastSeq = turns.reduce((max, turn) => Math.max(max, turn.seq), -1);
  const captures = capturesReasoning(run);

  return turns
    .map((turn): TurnRow => {
      const own = byDecision.get(turn.decisionIndex) ?? [];
      const narration = turn.text.trim();
      const reasoningState = reasoningStateOf(turn, captures);
      return {
        kind: 'turn',
        turnIndex: turn.turnIndex,
        decisionIndex: turn.decisionIndex,
        seq: turn.seq,
        narration: turn.text,
        hasNarration: narration !== '',
        reasoning: reasoningState === 'present' ? (turn.reasoningText ?? null) : null,
        reasoningState,
        reasoningTokens: turn.reasoningTokens ?? null,
        stopReason: turn.stopReason,
        actions: own,
        phase: dominantPhase(own),
        headline: headlineFor(own, turn.stopReason),
        targets: describeTargets(own),
        isFinal: turn.seq === lastSeq,
        event: turn,
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Turns and markers on one logical clock. Markers keep their exact `seq`, so an exposure
 * lands between the turn before it and the turn after it rather than being attached to
 * either — which turn first *followed* an exposure is the thing being measured.
 */
export function activityRowsOf(
  turns: readonly TurnRow[],
  markers: readonly MarkerRow[],
): ActivityRow[] {
  return [...turns, ...markers].sort((a, b) => a.seq - b.seq);
}

/** The closing report: the last turn's text, which is the only narration in the corpus. */
export function finalReportOf(turns: readonly TurnRow[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn !== undefined && turn.hasNarration) return turn.narration;
  }
  return '';
}

export interface DecisionRange {
  min: number;
  max: number;
}

/**
 * The span the cursor can move over. Taken from `decision_boundary` events — the record of
 * model calls that actually happened — and widened to cover any turn recorded outside it.
 */
export function decisionRangeOf(trace: readonly TraceEvent[]): DecisionRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const event of trace) {
    if (event.type !== 'decision_boundary' && event.type !== 'assistant_turn') continue;
    min = Math.min(min, event.decisionIndex);
    max = Math.max(max, event.decisionIndex);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}
