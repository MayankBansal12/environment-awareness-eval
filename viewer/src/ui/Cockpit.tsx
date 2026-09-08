/**
 * The run cockpit: test cases, agent activity, terminal logs and the Slack workspace on
 * screen at once, all slaved to one cursor.
 *
 * The cursor is a `decisionIndex` — the experiment's own clock, and the only unit at which
 * the harness ever changes what the model can perceive. Because all four panes read it,
 * moving it once answers the question the eval exists to ask: at this exact model call,
 * what was in the channel, what did the model know about it, what had it already done, and
 * what did it do next.
 *
 * The cursor starts at the end of the run, so the default view is the whole run rather
 * than an empty one, and scrubbing back is what reveals history.
 */

import { useEffect, useMemo, useState } from 'react';
import { environmentEventOf, slackThreadOf } from '../derive/slack.js';
import type { RunBundle } from '../derive/model.js';
import { actionRowsOf, markerRowsOf } from '../derive/timeline.js';
import {
  activityRowsOf,
  decisionRangeOf,
  finalReportOf,
  turnRowsOf,
} from '../derive/turns.js';
import { RunHeader } from './RunHeader.js';
import { ActivityPane } from './ActivityPane.js';
import { CaseRail } from './CaseRail.js';
import { ContextPanel, type ContextSelection } from './ContextPanel.js';
import { SlackPane } from './SlackPane.js';
import { TerminalPane, type LogFilter } from './TerminalPane.js';

interface Props {
  run: RunBundle;
  /** Every run for the current model, for the rail. */
  siblings: readonly RunBundle[];
  onSelectRun: (runId: string) => void;
}

export function Cockpit({ run, siblings, onSelectRun }: Props): JSX.Element {
  const actions = useMemo(() => actionRowsOf(run), [run]);
  const markers = useMemo(() => markerRowsOf(run.trace), [run]);
  const turns = useMemo(() => turnRowsOf(run, actions), [run, actions]);
  const rows = useMemo(() => activityRowsOf(turns, markers), [turns, markers]);
  const messages = useMemo(() => slackThreadOf(run.trace), [run]);
  const range = useMemo(() => decisionRangeOf(run.trace), [run]);
  const finalReport = useMemo(() => finalReportOf(turns), [turns]);

  const [cursor, setCursor] = useState<number>(range.max);
  const [filter, setFilter] = useState<LogFilter>('shell');

  // Switching runs must not leave the cursor pointing past the end of the new run.
  useEffect(() => {
    setCursor(range.max);
  }, [run.runId, range.max]);

  const clamp = (value: number): number => Math.min(range.max, Math.max(range.min, value));

  const event = environmentEventOf(messages);
  const indicatorAt = event?.indicatedAtDecision ?? null;
  const contentAt = event?.exposedAtDecision ?? null;

  // The context panel needs only a decision, so the cursor is passed straight through
  // rather than threading a synthetic timeline row for it to unwrap again.
  const selected = useMemo(
    (): ContextSelection => ({ kind: 'decision', decisionIndex: cursor }),
    [cursor],
  );

  return (
    <div className="cockpit">
      <CaseRail runs={siblings} selectedRunId={run.runId} onSelect={onSelectRun} />

      <div className="cockpit-centre">
        <ActivityPane
          rows={rows}
          cursor={cursor}
          gapFrom={indicatorAt}
          gapTo={contentAt}
          onSelect={(decisionIndex) => setCursor(clamp(decisionIndex))}
          finalReport={finalReport}
          run={run}
        />
        <TerminalPane
          run={run}
          actions={actions}
          cursor={cursor}
          filter={filter}
          onFilterChange={setFilter}
          onSelect={(decisionIndex) => setCursor(clamp(decisionIndex))}
        />
      </div>

      <div className="cockpit-right">
        <SlackPane
          run={run}
          messages={messages}
          cursor={cursor}
          onJumpToDecision={(decisionIndex) => setCursor(clamp(decisionIndex))}
        />
        <details className="context-disclosure">
          <summary>Agent context · D{cursor}</summary>
          <ContextPanel run={run} selected={selected} />
        </details>
      </div>

      <details className="run-diagnostics">
        <summary>Run metadata & evaluation details</summary>
        <RunHeader run={run} />
      </details>

      <Scrubber
        cursor={cursor}
        range={range}
        indicatorAt={indicatorAt}
        contentAt={contentAt}
        onChange={(value) => setCursor(clamp(value))}
      />
    </div>
  );
}

/**
 * The clock. Marks the two decisions that carry the result — where the update was first
 * indicated and where its text first entered context — so the gap is a distance on a
 * ruler rather than a number to be read and mentally subtracted.
 */
function Scrubber({
  cursor,
  range,
  indicatorAt,
  contentAt,
  onChange,
}: {
  cursor: number;
  range: { min: number; max: number };
  indicatorAt: number | null;
  contentAt: number | null;
  onChange: (value: number) => void;
}): JSX.Element {
  const span = Math.max(range.max - range.min, 1);
  const percent = (value: number): string =>
    `${(((value - range.min) / span) * 100).toFixed(2)}%`;

  return (
    <div className="scrubber">
      <button
        disabled={cursor <= range.min}
        onClick={() => onChange(cursor - 1)}
        aria-label="Previous decision"
        title="previous decision"
      >
        ◀
      </button>

      <div className="scrub-track">
        <input
          aria-label="Decision in run"
          type="range"
          min={range.min}
          max={range.max}
          value={cursor}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {indicatorAt !== null && (
          <span
            className="scrub-mark indicator"
            style={{ left: percent(indicatorAt) }}
            title={`indicator exposed at D${indicatorAt}`}
          />
        )}
        {contentAt !== null && (
          <span
            className="scrub-mark content"
            style={{ left: percent(contentAt) }}
            title={`content exposed at D${contentAt}`}
          />
        )}
      </div>

      <button
        disabled={cursor >= range.max}
        onClick={() => onChange(cursor + 1)}
        aria-label="Next decision"
        title="next decision"
      >
        ▶
      </button>

      <button onClick={() => onChange(range.max)} disabled={cursor === range.max}>
        End of run
      </button>
      <span className="scrub-label">
        D{cursor} / D{range.max}
      </span>

      {indicatorAt !== null && (
        <button className="jump" onClick={() => onChange(indicatorAt)}>
          ⇥ indicator D{indicatorAt}
        </button>
      )}
      {contentAt !== null && (
        <button className="jump" onClick={() => onChange(contentAt)}>
          ⇥ content D{contentAt}
        </button>
      )}
    </div>
  );
}
