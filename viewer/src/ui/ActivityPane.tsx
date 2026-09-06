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

/**
 * What to say when there is nothing to show. Each case is a different fact, and saying
 * "no reasoning" for all of them would let a reader blame the model for a gap that
 * belongs to the harness or the provider.
 */
const REASONING_NOTE: Record<ReasoningState, string> = {
  present: '',
  redacted: 'reasoning redacted by a safety filter — no plaintext returned',
  none_returned: 'provider returned no reasoning for this turn',
  not_captured:
    'this trace predates reasoning capture (trace < v4) — nothing was recorded either way',
};

interface Props {
  rows: readonly ActivityRow[];
  cursor: number;
  gapFrom: number | null;
  gapTo: number | null;
  onSelect: (decisionIndex: number) => void;
  finalReport: string;
}

export function ActivityPane({
  rows,
  cursor,
  gapFrom,
  gapTo,
  onSelect,
  finalReport,
}: Props): JSX.Element {
  const inGap = (decisionIndex: number): boolean =>
    gapFrom !== null && gapTo !== null && decisionIndex > gapFrom && decisionIndex < gapTo;

  return (
    <section className="pane activitypane">
      <h3>
        agent activity
        <span className="pane-note">reasoning · tool intent · summary</span>
      </h3>

      <div className="pane-body">
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

        {finalReport !== '' && (
          <div className="finalreport">
            <div className="fr-title">■ final report</div>
            <div className="fr-body">{finalReport}</div>
          </div>
        )}
      </div>
    </section>
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
    <div className={classes} onClick={() => onSelect(turn.decisionIndex)}>
      <div className="turn-head">
        <span className="tl-d">D{turn.decisionIndex}</span>
        {turn.phase !== null && (
          <span className={`glyph ${turn.phase}`}>{PHASE_GLYPH[turn.phase]}</span>
        )}
        <span className="turn-headline">{turn.headline}</span>
        {turn.targets !== '' && <span className="turn-targets">{turn.targets}</span>}
      </div>

      {turn.reasoning !== null && (
        <div className="reasoning">
          <span className="reasoning-tag">reasoning</span>
          {turn.reasoning}
        </div>
      )}

      {turn.hasNarration ? (
        <div className="narration">{turn.narration}</div>
      ) : (
        turn.reasoning === null && (
          <div className="narration none">{REASONING_NOTE[turn.reasoningState]}</div>
        )
      )}

      {turn.reasoningTokens !== null && turn.reasoning === null && (
        <div className="narration none">
          {turn.reasoningTokens} reasoning token
          {turn.reasoningTokens === 1 ? '' : 's'} billed — text not returned by the provider
        </div>
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
    </div>
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
    <div className={`band ${row.marker}`} onClick={() => onSelect(row.decisionIndex)}>
      <div className="band-title">
        {row.marker === 'trigger' || row.marker === 'termination'
          ? row.title
          : `${row.title}  ·  D${row.decisionIndex}`}
      </div>
      {row.detail !== '' && <div className="band-detail">{row.detail}</div>}
    </div>
  );
}
