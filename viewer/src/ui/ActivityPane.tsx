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

import { useState } from 'react';
import { outcomeLabel } from './labels.js';
import { classificationTone } from '../derive/metrics.js';
import type { RunBundle } from '../derive/model.js';
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
  redacted: 'Reasoning redacted by provider',
  none_returned: 'No reasoning returned',
  not_captured: 'Reasoning not captured in this trace version',
};

interface Props {
  rows: readonly ActivityRow[];
  cursor: number;
  gapFrom: number | null;
  gapTo: number | null;
  onSelect: (decisionIndex: number) => void;
  finalReport: string;
  run: RunBundle;
}

export function ActivityPane({
  rows,
  cursor,
  gapFrom,
  gapTo,
  onSelect,
  finalReport,
  run,
}: Props): JSX.Element {
  const [view, setView] = useState<'summary' | 'activity'>('summary');
  const turns = rows.filter((row): row is TurnRow => row.kind === 'turn');
  const actions = turns.flatMap((turn) => turn.actions);
  const inGap = (decisionIndex: number): boolean =>
    gapFrom !== null && gapTo !== null && decisionIndex > gapFrom && decisionIndex < gapTo;

  return (
    <section className="pane activitypane">
      <h3>
        <span>Agent overview</span>
        <span className="nav" aria-label="Agent view">
          <button
            aria-pressed={view === 'summary'}
            className={view === 'summary' ? 'active' : ''}
            onClick={() => setView('summary')}
          >
            Summary
          </button>
          <button
            aria-pressed={view === 'activity'}
            className={view === 'activity' ? 'active' : ''}
            onClick={() => setView('activity')}
          >
            Activity & reasoning
          </button>
        </span>
      </h3>

      {rows.some(
        (row) => row.kind !== 'marker' && row.reasoningState === 'not_captured',
      ) && (
        <p className="capture-note">
          This trace predates reasoning capture. Activity below shows recorded actions.
        </p>
      )}
      <div className="pane-body">
        {view === 'summary' ? (
          <div className="agent-summary">
            <div className="eyebrow">Whole-run summary</div>
            <h2>{outcomeLabel(run.summary.grade.classification)}</h2>
            <span className={`outcome-badge ${classificationTone(run)}`}>
              Stopped: {run.summary.termination.reason.replace(/_/g, ' ')}
            </span>
            <div className="agent-stats">
              <div>
                <b>{turns.length}</b>
                <span>decisions</span>
              </div>
              <div>
                <b>{actions.length}</b>
                <span>tool calls</span>
              </div>
              <div>
                <b>{actions.filter((action) => action.phase === 'modify').length}</b>
                <span>edit actions</span>
              </div>
              <div>
                <b>{actions.filter((action) => action.phase === 'test').length}</b>
                <span>test actions</span>
              </div>
            </div>
            <div className="summary-update">
              <div className="eyebrow">Response to the environment update</div>
              <p>
                {gapFrom === null
                  ? 'No update indicator was recorded.'
                  : gapTo === null
                    ? `The agent received an indicator at D${gapFrom}, but never received the message content.`
                    : `Update indicated at D${gapFrom}; message content entered the agent’s context at D${gapTo}.`}
              </p>
              <button
                onClick={() => {
                  setView('activity');
                  onSelect(gapTo ?? gapFrom ?? cursor);
                }}
              >
                Inspect agent activity →
              </button>
            </div>
            <div className="fr-title">Agent’s closing message · recorded text</div>
            <div className="fr-body">
              {finalReport ||
                'No closing message recorded. Open activity to inspect the recorded actions.'}
            </div>
          </div>
        ) : (
          rows.map((row) =>
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
          )
        )}

        {view === 'activity' && finalReport !== '' && (
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
    <div
      className={classes}
      role="button"
      tabIndex={0}
      aria-label={`Inspect decision ${turn.decisionIndex}`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(turn.decisionIndex);
        }
      }}
      onClick={() => onSelect(turn.decisionIndex)}
    >
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
        turn.reasoning === null &&
        turn.reasoningState !== 'not_captured' && (
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
