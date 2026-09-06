/**
 * The vertical timeline, ordered on the trace's logical clock.
 *
 * Exposure markers are full-width bands rather than icons: the vertical distance between
 * the indicator band and the content band is the headline metric, so it has to be
 * physically legible on the page. Rows between the two are tinted, because work done in
 * that window is obsolete work under monitoring latency — not disobedience.
 */

import { Fragment } from 'react';
import type {
  ActionRow,
  MarkerRow,
  PhaseBand,
  TimelineRow,
  WorkspaceState,
} from '../derive/model.js';
import { groupIntoBatches } from '../derive/batches.js';
import { PHASE_GLYPH } from '../derive/phases.js';
import { stateAt } from '../derive/timeline.js';

export type Zoom = 'digest' | 'actions' | 'raw';

interface Props {
  rows: TimelineRow[];
  zoom: Zoom;
  states: Map<number, WorkspaceState>;
  expanded: Set<number>;
  onToggleBand: (key: number) => void;
  selectedSeq: number | null;
  onSelect: (row: ActionRow | MarkerRow) => void;
  indicatorSeq: number | null;
  contentSeq: number | null;
}

export function Timeline({
  rows,
  zoom,
  states,
  expanded,
  onToggleBand,
  selectedSeq,
  onSelect,
  indicatorSeq,
  contentSeq,
}: Props): JSX.Element {
  const inGap = (seq: number): boolean =>
    indicatorSeq !== null && contentSeq !== null && seq > indicatorSeq && seq < contentSeq;

  return (
    <div className="timeline">
      <div className="tl-head">
        <span>D</span>
        <span />
        <span>what the model did</span>
        <span>target</span>
        <span>state</span>
      </div>

      {rows.map((row, index) => {
        if (row.kind === 'marker') return <Marker key={`m${index}`} row={row} onSelect={onSelect} />;

        if (row.kind === 'band') {
          const isExpanded = expanded.has(index);
          return (
            <Fragment key={`b${index}`}>
              <BandRow
                band={row}
                expanded={isExpanded}
                inGap={inGap(row.actions[0]!.seq)}
                state={stateAt(states, row.toDecision)}
                onClick={() => onToggleBand(index)}
              />
              {isExpanded &&
                renderActions(row.actions, {
                  zoom,
                  states,
                  selectedSeq,
                  onSelect,
                  inGap,
                })}
            </Fragment>
          );
        }

        return (
          <Fragment key={`a${index}`}>
            {renderActions([row], { zoom, states, selectedSeq, onSelect, inGap })}
          </Fragment>
        );
      })}
    </div>
  );
}

function renderActions(
  actions: ActionRow[],
  ctx: {
    zoom: Zoom;
    states: Map<number, WorkspaceState>;
    selectedSeq: number | null;
    onSelect: (row: ActionRow) => void;
    inGap: (seq: number) => boolean;
  },
): JSX.Element[] {
  // Siblings issued in one assistant message are bracketed so a parallel batch never
  // reads as a sequence; the order they settled in is a race and means nothing.
  return groupIntoBatches(actions).map((batch, index) => {
    const body = batch.actions.map((action) => (
      <ActionRowView
        key={action.actionIndex}
        action={action}
        zoom={ctx.zoom}
        state={stateAt(ctx.states, action.decisionIndex)}
        selected={ctx.selectedSeq === action.seq}
        inGap={ctx.inGap(action.seq)}
        onSelect={ctx.onSelect}
      />
    ));

    if (!batch.isParallel) return <Fragment key={index}>{body}</Fragment>;

    return (
      <div className="batch" key={index}>
        <div className="batch-label">
          ┌ parallel batch · {batch.actions.length} calls issued together (D
          {batch.decisionIndex})
        </div>
        {body}
      </div>
    );
  });
}

function ActionRowView({
  action,
  zoom,
  state,
  selected,
  inGap,
  onSelect,
}: {
  action: ActionRow;
  zoom: Zoom;
  state: WorkspaceState | null;
  selected: boolean;
  inGap: boolean;
  onSelect: (row: ActionRow) => void;
}): JSX.Element {
  if (zoom === 'raw') {
    return (
      <div
        className={rowClass(selected, inGap)}
        onClick={() => onSelect(action)}
        style={{ gridTemplateColumns: '78px 1fr' }}
      >
        <span className="tl-d">D{action.decisionIndex}</span>
        <pre className="block" style={{ padding: 0 }}>
          {JSON.stringify(action.event, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div className={rowClass(selected, inGap)} onClick={() => onSelect(action)}>
      <span className="tl-d">
        D{action.decisionIndex}
        <span className="expandable"> ·{action.actionIndex}</span>
      </span>
      <span className={`glyph ${action.phase}`}>{PHASE_GLYPH[action.phase]}</span>
      <span className="tl-what">
        <span className="phase-name">{action.phase}</span>
        {action.label}
        {action.blockedByHarness && <span className="err"> BLOCKED</span>}
        {action.isError && !action.blockedByHarness && <span className="err"> error</span>}
        {action.testOutcome !== null && (
          <span className={`outcome ${action.testOutcome}`}>
            {' '}
            {action.testOutcome === 'passed'
              ? '✓ passed'
              : action.testOutcome === 'failed'
                ? '✗ failed'
                : '? unknown'}
          </span>
        )}
      </span>
      <span className="tl-target">{action.detail ?? ''}</span>
      <span className="tl-state">{describeState(state)}</span>
    </div>
  );
}

function BandRow({
  band,
  expanded,
  inGap,
  state,
  onClick,
}: {
  band: PhaseBand;
  expanded: boolean;
  inGap: boolean;
  state: WorkspaceState | null;
  onClick: () => void;
}): JSX.Element {
  const span =
    band.fromDecision === band.toDecision
      ? `D${band.fromDecision}`
      : `D${band.fromDecision}–D${band.toDecision}`;
  return (
    <div className={`tl-row${inGap ? ' gapzone' : ''}`} onClick={onClick}>
      <span className="tl-d">{span}</span>
      <span className={`glyph ${band.phase}`}>{PHASE_GLYPH[band.phase]}</span>
      <span className="tl-what">
        <span className="phase-name">{band.phase}</span>
        <span className="count">{band.composition}</span>
        <span className="expandable"> {expanded ? '▾' : '▸'}</span>
      </span>
      <span className="tl-target">{band.targets}</span>
      <span className="tl-state">{describeState(state)}</span>
    </div>
  );
}

function Marker({
  row,
  onSelect,
}: {
  row: MarkerRow;
  onSelect: (row: MarkerRow) => void;
}): JSX.Element {
  return (
    <div className={`band ${row.marker}`} onClick={() => onSelect(row)}>
      <div className="band-title">
        {row.marker === 'trigger' || row.marker === 'termination'
          ? row.title
          : `${row.title}  ·  D${row.decisionIndex}`}
      </div>
      {row.detail !== '' && <div className="band-detail">{row.detail}</div>}
    </div>
  );
}

function rowClass(selected: boolean, inGap: boolean): string {
  return `tl-row${selected ? ' selected' : ''}${inGap ? ' gapzone' : ''}`;
}

function describeState(state: WorkspaceState | null): string {
  if (state === null) return '';
  const parts: string[] = [];
  parts.push(state.sourceMutated ? '● mutated' : '○ clean');
  if (state.workingTreeDirty) parts.push('dirty');
  if (state.commitsAheadOfFixture > 0) parts.push(`+${state.commitsAheadOfFixture} commit`);
  return parts.join(' · ');
}
