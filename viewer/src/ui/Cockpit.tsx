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

import { useEffect, useMemo, useRef, useState } from 'react';
import { indicatorDecision, slackThreadOf } from '../derive/slack.js';
import type { RunBundle } from '../derive/model.js';
import { actionRowsOf, markerRowsOf } from '../derive/timeline.js';
import {
  activityRowsOf,
  decisionRangeOf,
  finalReportOf,
  turnRowsOf,
} from '../derive/turns.js';
import { ModelCallInspector } from './ModelCallInspector.js';
import { Evidence } from './Evidence.js';
import { href } from './App.js';
import { KIND_LABEL, decisionRows } from '../derive.js';
import { tokens, usd } from '../format.js';
import { useRun } from '../data.js';
import type { RunRow } from '../model.js';
import { modelLabel } from '../derive/metrics.js';
import { ActivityPane } from './ActivityPane.js';
import { CaseRail } from './CaseRail.js';
import { SlackPane } from './SlackPane.js';
import { TerminalPane, type LogFilter } from './TerminalPane.js';

interface Props {
  run: RunBundle;
  siblings?: readonly RunRow[];
  decision: number | null;
}
export function Cockpit({
  runKey,
  decision,
  siblings,
}: {
  runKey: string;
  decision: number | null;
  siblings: readonly RunRow[];
}) {
  const loaded = useRun(runKey);
  if (loaded.error) return <p className="error">{loaded.error}</p>;
  if (!loaded.data) return <p>Loading {runKey}…</p>;
  return <RunView key={runKey} run={loaded.data} decision={decision} siblings={siblings} />;
}
export function RunView({ run, siblings = [], decision }: Props): JSX.Element {
  const actions = useMemo(() => actionRowsOf(run), [run]);
  const markers = useMemo(() => markerRowsOf(run.trace), [run]);
  const turns = useMemo(() => turnRowsOf(run, actions), [run, actions]);
  const rows = useMemo(() => activityRowsOf(turns, markers), [turns, markers]);
  const messages = useMemo(() => slackThreadOf(run), [run]);
  const range = useMemo(() => decisionRangeOf(run.trace), [run]);
  const finalReport = useMemo(() => finalReportOf(turns), [turns]);

  const cursor = Math.min(range.max, Math.max(range.min, decision ?? range.max));
  const [filter, setFilter] = useState<LogFilter>('shell');
  const [mode, setMode] = useState<'cockpit' | 'detail'>('cockpit');
  const [update, setUpdate] = useState(
    run.summary.grade.events[0]?.kind ?? 'requirement_change',
  );
  const inspectorRef = useRef<HTMLElement>(null);
  const clamp = (value: number) => Math.min(range.max, Math.max(range.min, value));
  const setCursor = (d: number) => {
    history.replaceState(null, '', href.run(run.key, clamp(d)));
    dispatchEvent(new HashChangeEvent('hashchange'));
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          'input, select, textarea, button, a, summary, [role="button"], [contenteditable]',
        )
      )
        return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setCursor(cursor + (e.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });
  const event = run.summary.grade.events.find((e) => e.kind === update);
  const indicatorAt = indicatorDecision(run, event?.eventId ?? null);
  const cueAt = event?.cueDecision ?? null;
  const contentAt = event?.contentDecision ?? null;
  const input = run.trace.find((e) => e.type === 'input' && e.decision === cursor);
  const totals = useMemo(() => decisionRows(run.trace), [run])[cursor - 1];
  const model = modelLabel(run);
  const models = [...new Set(siblings.map((r) => r.model))];
  const onSelectRun = (key: string) => {
    location.hash = href.run(key);
  };
  const switchModel = (next: string) => {
    const pool = siblings.filter((r) => r.model === next);
    const c = run.summary.condition;
    const match =
      pool.find(
        (r) =>
          r.condition.family === c.family &&
          r.condition.load === c.load &&
          r.condition.noise === c.noise &&
          r.condition.delivery === c.delivery,
      ) ?? pool[0];
    if (match) onSelectRun(match.key);
  };

  return (
    <>
      <div className="controls runstrip">
        <button
          onClick={() => {
            location.hash = href.runs();
          }}
        >
          ← runs
        </button>
        <label>
          model{' '}
          <select value={model} onChange={(e) => switchModel(e.target.value)}>
            {(models.length ? models : [model]).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <span className="kv">
          <b>{run.summary.runId}</b> · {run.summary.condition.family} /{' '}
          {run.summary.condition.load} / {run.summary.condition.noise} /{' '}
          {run.summary.condition.delivery}
        </span>
        <div className="spacer" />
        <span className="nav">
          {(['cockpit', 'detail'] as const).map((m) => (
            <button
              key={m}
              className={mode === m ? 'active' : ''}
              onClick={() => setMode(m)}
            >
              {m === 'cockpit' ? 'Behavior' : 'Evidence'}
            </button>
          ))}
        </span>
      </div>
      <div className="controls update-controls">
        <label>
          Update{' '}
          <select
            value={update}
            onChange={(e) => setUpdate(e.target.value as typeof update)}
          >
            {run.summary.grade.events.map((e) => (
              <option key={e.kind} value={e.kind}>
                {KIND_LABEL[e.kind]}
                {e.missed ? ' · missed' : ''}
                {!e.fired ? ' · not fired' : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="kv">
          {event?.fired
            ? `Fired D${event.firedDecision} · cue ${cueAt === null ? 'not retrieved' : 'D' + cueAt} · content ${contentAt === null ? 'not retrieved' : 'D' + contentAt}`
            : 'Update did not fire'}
        </span>
        <span className="spacer" />
        <span className="kv">
          Through D{cursor}: {tokens(totals?.cumulativeTokens ?? 0)} tokens ·{' '}
          {usd(totals?.cumulativeCostUsd ?? 0)} · turn calls
        </span>
      </div>
      {mode === 'detail' ? (
        <>
          <Evidence run={run} selected={cursor} select={setCursor} />
          <ModelCallInspector run={run} decisionIndex={cursor} />
        </>
      ) : (
        <div className="cockpit">
          <CaseRail
            runs={siblings.filter((r) => r.model === model)}
            selectedRunId={run.key}
            onSelect={onSelectRun}
          />

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
              <summary>Environment blocks · D{cursor}</summary>
              <pre className="call-body">
                {input?.type === 'input' ? input.status : 'No input status recorded.'}
              </pre>
            </details>
          </div>

          {/* Reads the same cursor as every other pane, so moving the clock once moves the
          whole cockpit — including what the model was actually sent at that decision. */}
          <ModelCallInspector ref={inspectorRef} run={run} decisionIndex={cursor} />

          <details className="run-diagnostics">
            <summary>Run metadata & evaluation details</summary>
            <Evidence run={run} selected={cursor} select={setCursor} />
          </details>

          <Scrubber
            cursor={cursor}
            range={range}
            indicatorAt={indicatorAt}
            cueAt={cueAt}
            contentAt={contentAt}
            onChange={(value) => setCursor(clamp(value))}
            onInspect={() => inspectorRef.current?.scrollIntoView({ block: 'start' })}
          />
        </div>
      )}
    </>
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
  cueAt,
  contentAt,
  onChange,
  onInspect,
}: {
  cursor: number;
  range: { min: number; max: number };
  indicatorAt: number | null;
  cueAt: number | null;
  contentAt: number | null;
  onChange: (value: number) => void;
  /** Scrolls to the model-call inspector for the decision the cursor is on. */
  onInspect: () => void;
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
        {cueAt !== null && (
          <span
            className="scrub-mark cue"
            style={{ left: percent(cueAt) }}
            title={`cue retrieved at D${cueAt}`}
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
      <button onClick={onInspect}>Inspect D{cursor}</button>
      <span className="scrub-label">
        D{cursor} / D{range.max}
      </span>

      {indicatorAt !== null && (
        <button className="jump" onClick={() => onChange(indicatorAt)}>
          ⇥ indicator D{indicatorAt}
        </button>
      )}
      {cueAt !== null && (
        <button className="jump" onClick={() => onChange(cueAt)}>
          ⇥ cue D{cueAt}
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
