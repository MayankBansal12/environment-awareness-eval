/**
 * Agent activity: one row per decision, plus the protocol markers between them.
 *
 * Rows at or before the cursor are live; rows after it are dimmed rather than hidden, so
 * the run keeps its full shape while the cursor still means something. Clicking a row
 * moves the cursor to that decision, which is the single interaction that keeps the
 * terminal, the Slack channel and the context panel showing the same instant.
 *
 * Narration is printed only where the trace actually recorded it. Where it did not, the
 * row says so — the alternative, paraphrasing the tool calls as if they were the model's
 * stated intent, would be the viewer inventing evidence.
 */

import { PHASE_GLYPH } from '../derive/phases.js';
import type { MarkerRow } from '../derive/model.js';
import type { ActivityRow, ReasoningState, TurnRow } from '../derive/turns.js';
import { useRevealSelected } from './useRevealSelected.js';

/**
 * What to say when there is nothing to show. Each case is a different fact, and saying
 * "no reasoning" for all of them would let a reader blame the model for a gap that
 * belongs to the harness or the provider.
 */
const REASONING_NOTE: Record<ReasoningState, string> = {
  present: '',
  redacted: 'Reasoning redacted by provider',
  none_returned: 'No reasoning returned',
  not_captured: 'Reasoning not captured for this decision',
};

interface Props {
  rows: readonly ActivityRow[];
  cursor: number;
  gapFrom: number | null;
  gapTo: number | null;
  onSelect: (decisionIndex: number) => void;
}

export function ActivityPane({
  rows,
  cursor,
  gapFrom,
  gapTo,
  onSelect,
}: Props): JSX.Element {
  const bodyRef = useRevealSelected('.turncard.active', cursor);
  const inGap = (decisionIndex: number): boolean =>
    gapFrom !== null &&
    decisionIndex >= gapFrom &&
    (gapTo === null || decisionIndex < gapTo);

  return (
    <div className="activitypane pane-body" ref={bodyRef}>
      {rows.map((row) =>
        row.kind === 'marker' ? (
          <MarkerBand key={`m${row.seq}`} row={row} onSelect={onSelect} />
        ) : (
          <TurnCard
            key={`t${row.seq}`}
            turn={row}
            active={row.decisionIndex === cursor}
            future={row.decisionIndex > cursor}
            inGap={inGap(row.decisionIndex)}
            onSelect={onSelect}
          />
        ),
      )}
    </div>
  );
}

function TurnCard({
  turn,
  active,
  future,
  inGap,
  onSelect,
}: {
  turn: TurnRow;
  active: boolean;
  future: boolean;
  inGap: boolean;
  onSelect: (decisionIndex: number) => void;
}): JSX.Element {
  const classes = [
    'turncard',
    active ? 'active' : '',
    future ? 'future' : '',
    inGap ? 'gapzone' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes}>
      <button
        className="turn-head turn-select"
        aria-label={`Inspect decision ${turn.decisionIndex}`}
        aria-current={active ? 'step' : undefined}
        onClick={() => onSelect(turn.decisionIndex)}
      >
        <span className="tl-d">D{turn.decisionIndex}</span>
        {turn.phase !== null && (
          <span className={`glyph ${turn.phase}`}>{PHASE_GLYPH[turn.phase]}</span>
        )}
        <span className="turn-headline" title={turn.headline}>
          {turn.isFinal ? 'Finished' : turn.headline}
        </span>
        {turn.targets !== '' && <span className="turn-targets">{turn.targets}</span>}
      </button>

      {turn.hasNarration &&
        (turn.isFinal ? (
          <details className="turn-message">
            <summary>Final response</summary>
            <div className="narration">{turn.narration}</div>
          </details>
        ) : (
          <div className="narration">{turn.narration}</div>
        ))}

      {active && turn.reasoningState !== 'none_returned' && (
        <details className="turn-reasoning">
          <summary>
            {turn.reasoning !== null ? 'Reasoning' : REASONING_NOTE[turn.reasoningState]}
          </summary>
          {turn.reasoning !== null && <div className="reasoning">{turn.reasoning}</div>}
          {turn.reasoningTokens !== null && turn.reasoning === null && (
            <p className="muted small">
              {turn.reasoningTokens} reasoning tokens billed; text unavailable.
            </p>
          )}
        </details>
      )}

      {turn.actions.length > 0 && (
        <div className="turn-calls">
          {turn.actions.map((action) => (
            <span
              key={action.actionIndex}
              className={`callchip ${action.phase}${action.isError ? ' err' : ''}`}
              title={action.label}
            >
              {action.toolName}
              {action.blockedByHarness && ' ⛔'}
              {action.testOutcome === 'passed' && ' ✓'}
              {action.testOutcome === 'failed' && ' ✗'}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function MarkerBand({
  row,
  onSelect,
}: {
  row: MarkerRow;
  onSelect: (decisionIndex: number) => void;
}): JSX.Element {
  return (
    <button
      className={`band ${row.marker}`}
      title={row.detail}
      onClick={() => onSelect(row.decisionIndex)}
    >
      <div className="band-title">
        {row.marker === 'trigger' || row.marker === 'termination'
          ? row.title
          : `${row.title}  ·  D${row.decisionIndex}`}
      </div>
    </button>
  );
}
