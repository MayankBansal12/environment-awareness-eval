/**
 * Screen 3 — two runs side by side, rows aligned on `decisionIndex`.
 *
 * `decisionIndex` is a shared logical clock across runs (docs/architecture.md, "Logical
 * time"), so aligning on it is well defined: D9 in one run and D9 in another are both "the
 * ninth model decision opportunity", regardless of wall-clock or action counts. A decision
 * present in one run and absent in the other renders as a hatched blank, so divergence in
 * trajectory length stays visible instead of silently shifting rows out of alignment.
 */

import { useMemo, useState } from 'react';
import { data } from '../data.js';
import {
  committedAfterContent,
  isValid,
  mutatedAfterContent,
  ticketDeliveryOf,
} from '../derive/metrics.js';
import type { ActionRow, MarkerRow, RunBundle } from '../derive/model.js';
import { PHASE_GLYPH } from '../derive/phases.js';
import { actionRowsOf, markerRowsOf } from '../derive/timeline.js';

interface Side {
  run: RunBundle;
  actions: ActionRow[];
  markers: MarkerRow[];
}

export function Compare({
  initialA,
  initialB,
}: {
  initialA: string | null;
  initialB: string | null;
}): JSX.Element {
  const [aId, setAId] = useState<string>(initialA ?? data.runs[0]?.runId ?? '');
  const [bId, setBId] = useState<string>(
    initialB ?? data.runs[1]?.runId ?? data.runs[0]?.runId ?? '',
  );

  const a = useSide(aId);
  const b = useSide(bId);

  const maxDecision = Math.max(
    lastDecision(a),
    lastDecision(b),
    0,
  );
  const decisions = Array.from({ length: maxDecision + 1 }, (_, index) => index);

  return (
    <>
      <div className="controls">
        <label>
          A
          <RunSelect value={aId} onChange={setAId} />
        </label>
        <label>
          B
          <RunSelect value={bId} onChange={setBId} />
        </label>
      </div>

      <div className="compare">
        {[a, b].map((side, index) => (
          <div className="compare-col" key={index}>
            <h4>
              {index === 0 ? 'A' : 'B'} · {side === null ? '—' : side.run.runId}
              {side !== null && (
                <span className="kv">
                  {'  '}ticket: {ticketDeliveryOf(side.run)} ·{' '}
                  {side.run.summary.scenarioId}
                  {!isValid(side.run) && <span className="warn"> · INVALID</span>}
                </span>
              )}
            </h4>
            {decisions.map((decision) => (
              <DecisionCell key={decision} side={side} decision={decision} />
            ))}
          </div>
        ))}
      </div>

      <div className="cmp-foot">
        <div>A: {verdict(a)}</div>
        <div>B: {verdict(b)}</div>
      </div>
    </>
  );
}

function DecisionCell({
  side,
  decision,
}: {
  side: Side | null;
  decision: number;
}): JSX.Element {
  if (side === null) return <div className="cmp-row blank" />;

  const markers = side.markers.filter((marker) => marker.decisionIndex === decision);
  const actions = side.actions.filter((action) => action.decisionIndex === decision);

  if (markers.length === 0 && actions.length === 0) {
    return <div className="cmp-row blank" />;
  }

  return (
    <>
      {markers.map((marker, index) => (
        <div className={`band ${marker.marker}`} key={`m${index}`}>
          <span className="band-title">{shortMarker(marker)}</span>
        </div>
      ))}
      {actions.map((action) => (
        <div className="cmp-row" key={action.actionIndex}>
          <span className="tl-d">D{String(decision).padStart(2, '0')}</span>
          <span className="tl-what">
            <span className={`glyph ${action.phase}`}>{PHASE_GLYPH[action.phase]}</span>{' '}
            {action.label}
          </span>
          <span>
            {action.testOutcome === 'passed' && <span className="outcome passed">✓</span>}
            {action.testOutcome === 'failed' && <span className="outcome failed">✗</span>}
            {action.phase === 'commit' && <span className="warn">⚠</span>}
          </span>
        </div>
      ))}
    </>
  );
}

function shortMarker(marker: MarkerRow): string {
  switch (marker.marker) {
    case 'indicator':
      return '▓▓ INDICATOR EXPOSED';
    case 'content':
      return '▒▒ CONTENT EXPOSED';
    case 'steer':
      return '▒▒ STEERED CONTENT';
    case 'trigger':
      return `═══ ${marker.title} ═══`;
    default:
      return marker.title;
  }
}

/** A one-line reading of the side, in the terms the experiment cares about. */
function verdict(side: Side | null): string {
  if (side === null) return '—';
  const metrics = side.run.summary.grade.metrics as unknown as Record<string, unknown>;
  const indicator = metrics['indicatorDecision'];
  const gap = metrics['indicatorToContentDecisions'];
  const parts: string[] = [];

  if (typeof indicator !== 'number') parts.push('no indicator exposure');
  else if (typeof gap !== 'number') parts.push('never inspected after the indicator');
  else parts.push(`inspected after ${gap} decision${gap === 1 ? '' : 's'}`);

  if (committedAfterContent(side.run.summary)) parts.push('committed after content');
  else if (mutatedAfterContent(side.run.summary)) parts.push('mutated after content');

  parts.push(side.run.summary.grade.classification);
  return parts.join(', ');
}

function lastDecision(side: Side | null): number {
  if (side === null) return 0;
  const values = [
    ...side.actions.map((action) => action.decisionIndex),
    ...side.markers.map((marker) => marker.decisionIndex),
  ];
  return values.length === 0 ? 0 : Math.max(...values);
}

function useSide(runId: string): Side | null {
  return useMemo(() => {
    const run = data.runs.find((candidate) => candidate.runId === runId);
    if (run === undefined) return null;
    return {
      run,
      actions: actionRowsOf(run),
      markers: markerRowsOf(run.trace),
    };
  }, [runId]);
}

function RunSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {data.runs.map((run) => (
        <option key={run.runId} value={run.runId}>
          {run.runId}
        </option>
      ))}
    </select>
  );
}
