/** Run navigation, agent activity and incoming updates share one decision cursor. */
import { useEffect, useMemo, useState } from 'react';
import { indicatorDecision, slackThreadOf } from '../derive/slack.js';
import type { RunBundle } from '../derive/model.js';
import { actionRowsOf, markerRowsOf } from '../derive/timeline.js';
import { activityRowsOf, decisionRangeOf, turnRowsOf } from '../derive/turns.js';
import { ModelCallInspector } from './ModelCallInspector.js';
import { Evidence } from './Evidence.js';
import { href } from './App.js';
import { KIND_LABEL } from '../derive.js';
import { useRun } from '../data.js';
import type { RunRow } from '../model.js';
import {
  classificationTone,
  conditionLabel,
  modelLabel,
  outcomeLabel,
} from '../derive/metrics.js';
import { modelId, modelName } from '../derive/results.js';
import { ActivityPane } from './ActivityPane.js';
import { CaseRail } from './CaseRail.js';
import { SlackPane } from './SlackPane.js';
import { TerminalPane, type LogFilter } from './TerminalPane.js';

interface Props {
  run: RunBundle;
  siblings?: readonly RunRow[];
  decision: number | null;
  navigation?:
    | {
        key: string;
        error: string | null;
        retry: () => void;
      }
    | undefined;
}
type AgentPanel = 'activity' | 'tools' | 'call';

export function Cockpit({
  runKey,
  decision,
  siblings,
}: {
  runKey: string;
  decision: number | null;
  siblings: readonly RunRow[];
}) {
  const loaded = useRun(runKey, true);
  const [displayed, setDisplayed] = useState({ key: runKey, decision });
  if (
    loaded.data?.key === runKey &&
    (displayed.key !== runKey || displayed.decision !== decision)
  )
    setDisplayed({ key: runKey, decision });
  if (!loaded.data && loaded.error)
    return (
      <p className="error" role="alert">
        Could not load this run. <button onClick={loaded.retry}>Retry</button>{' '}
        <a href={href.runs()}>Back to models</a>
      </p>
    );
  if (!loaded.data) return <p>Loading {runKey}…</p>;
  const switching = loaded.data.key !== runKey;
  return (
    <RunView
      run={loaded.data}
      decision={switching ? displayed.decision : decision}
      siblings={siblings}
      navigation={
        switching ? { key: runKey, error: loaded.error, retry: loaded.retry } : undefined
      }
    />
  );
}

export function RunView({ run, siblings = [], decision, navigation }: Props): JSX.Element {
  const actions = useMemo(() => actionRowsOf(run), [run]);
  const markers = useMemo(() => {
    const noise = new Set(
      run.summary.team.events.filter((e) => !e.important).map((e) => e.id),
    );
    return markerRowsOf(
      run.trace.filter((e) =>
        e.type === 'environment_event'
          ? e.event.important
          : e.type === 'exposure'
            ? !noise.has(e.eventId)
            : true,
      ),
    );
  }, [run]);
  const turns = useMemo(() => turnRowsOf(run, actions), [run, actions]);
  const rows = useMemo(() => activityRowsOf(turns, markers), [turns, markers]);
  const messages = useMemo(() => slackThreadOf(run), [run]);
  const range = useMemo(() => decisionRangeOf(run.trace), [run]);
  const cursor = Math.min(range.max, Math.max(range.min, decision ?? range.max));
  const [filter, setFilter] = useState<LogFilter>('shell');
  const [details, setDetails] = useState(false);
  const [panel, setPanel] = useState<AgentPanel>('activity');
  const [update, setUpdate] = useState(
    run.summary.grade.events[0]?.kind ?? 'requirement_change',
  );
  const clamp = (value: number) => Math.min(range.max, Math.max(range.min, value));
  const setCursor = (d: number) => {
    if (navigation) return;
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
  const event =
    run.summary.grade.events.find((e) => e.kind === update) ?? run.summary.grade.events[0];
  const indicatorAt = indicatorDecision(run, event?.eventId ?? null);
  const cueAt = event?.cueDecision ?? null;
  const contentAt = event?.contentDecision ?? null;
  const model = modelId(modelLabel(run));
  const models = [...new Set(siblings.map((r) => modelId(r.model)))];
  const modelRuns = siblings.filter((r) => modelId(r.model) === model);
  const currentRow = modelRuns.find((r) => r.key === run.key);
  const caseRuns = currentRow
    ? modelRuns.filter(
        (r) =>
          r.experiment === currentRow.experiment &&
          conditionLabel(r) === conditionLabel(currentRow),
      )
    : [];
  const runNumber = caseRuns.findIndex((r) => r.key === run.key) + 1;
  const onSelectRun = (key: string) => {
    location.hash = href.run(key);
  };
  const switchModel = (next: string) => {
    const pool = siblings.filter((r) => modelId(r.model) === next);
    const c = run.summary.condition;
    const match =
      pool.find(
        (r) =>
          r.condition.family === c.family &&
          (r.condition.scenario ?? 'updates') === (c.scenario ?? 'updates') &&
          r.condition.load === c.load &&
          r.condition.noise === c.noise &&
          r.condition.delivery === c.delivery,
      ) ?? pool[0];
    if (match) onSelectRun(match.key);
  };

  return (
    <div className="run-workspace" aria-busy={!!navigation && !navigation.error}>
      <div className="controls runstrip">
        <a className="back-to-models" href={href.runs()}>
          ← models
        </a>
        <select
          aria-label="Model"
          value={model}
          onChange={(e) => switchModel(e.target.value)}
        >
          {(models.length ? models : [model]).map((m) => (
            <option key={m} value={m}>
              {modelName(m)}
            </option>
          ))}
        </select>
        <span className="run-case" title={run.summary.runId}>
          {run.summary.condition.family}
          {run.summary.condition.scenario && run.summary.condition.scenario !== 'updates'
            ? ` · ${run.summary.condition.scenario}`
            : ''}
          {runNumber > 0 ? ` · Run ${runNumber}` : ''}
        </span>
        <span className="spacer" />
        {navigation ? (
          <span className="run-load-status" role={navigation.error ? 'alert' : 'status'}>
            {navigation.error ? 'Could not load run.' : 'Loading run…'}
            {navigation.error && <button onClick={navigation.retry}>Retry</button>}
            <button
              onClick={() => {
                location.hash = href.run(run.key, decision);
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className={`classification ${classificationTone(run)}`}>
            {outcomeLabel(run)}
          </span>
        )}
        <button aria-pressed={details} onClick={() => setDetails(!details)}>
          {details ? 'Back to activity' : 'Run details'}
        </button>
      </div>

      {details ? (
        <Evidence run={run} selected={cursor} select={setCursor} />
      ) : (
        <>
          <div className="run-timeline">
            <div className="update-focus">
              <select
                aria-label="Update"
                disabled={!!navigation}
                value={event?.kind ?? update}
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
              {event?.fired ? (
                <div className="update-jumps">
                  {indicatorAt !== null && (
                    <button
                      disabled={!!navigation}
                      title="First update indicator in the agent's input"
                      onClick={() => setCursor(indicatorAt)}
                    >
                      Indicator D{indicatorAt}
                    </button>
                  )}
                  <span aria-hidden="true">→</span>
                  {contentAt !== null ? (
                    <button
                      disabled={!!navigation}
                      title="Update content first entered the agent's context"
                      onClick={() => setCursor(contentAt)}
                    >
                      Content D{contentAt}
                    </button>
                  ) : (
                    <span className="muted">No content read</span>
                  )}
                </div>
              ) : (
                <span className="muted small">Not fired</span>
              )}
            </div>
            <Scrubber
              disabled={!!navigation}
              cursor={cursor}
              range={range}
              indicatorAt={indicatorAt}
              cueAt={cueAt}
              contentAt={contentAt}
              onChange={setCursor}
            />
          </div>
          <div className="focused-cockpit">
            <CaseRail
              runs={modelRuns}
              selectedRunId={run.key}
              pendingRunId={navigation?.key}
              onSelect={onSelectRun}
            />
            <section className="pane agentpane">
              <h3>
                Agent
                <span className="nav" aria-label="Agent view">
                  {(
                    [
                      ['activity', 'Activity'],
                      ['tools', 'Tool logs'],
                      ['call', 'Model call'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      className={panel === value ? 'active' : ''}
                      aria-pressed={panel === value}
                      onClick={() => setPanel(value)}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </h3>
              {panel === 'activity' && (
                <ActivityPane
                  key={run.key}
                  rows={rows}
                  cursor={cursor}
                  gapFrom={indicatorAt}
                  gapTo={contentAt}
                  onSelect={setCursor}
                />
              )}
              {panel === 'tools' && (
                <TerminalPane
                  actions={actions}
                  cursor={cursor}
                  filter={filter}
                  onFilterChange={setFilter}
                  onSelect={setCursor}
                />
              )}
              {panel === 'call' && <ModelCallInspector run={run} decisionIndex={cursor} />}
            </section>
            <SlackPane
              messages={messages}
              cursor={cursor}
              selectedEventId={event?.eventId ?? null}
              onJumpToDecision={setCursor}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Scrubber({
  disabled,
  cursor,
  range,
  indicatorAt,
  cueAt,
  contentAt,
  onChange,
}: {
  disabled: boolean;
  cursor: number;
  range: { min: number; max: number };
  indicatorAt: number | null;
  cueAt: number | null;
  contentAt: number | null;
  onChange: (value: number) => void;
}): JSX.Element {
  const span = Math.max(range.max - range.min, 1);
  const percent = (value: number) => `${(((value - range.min) / span) * 100).toFixed(2)}%`;
  return (
    <div className="scrubber">
      <button
        disabled={disabled || cursor <= range.min}
        onClick={() => onChange(cursor - 1)}
        aria-label="Previous decision"
      >
        ‹
      </button>
      <div className="scrub-track">
        <input
          disabled={disabled}
          aria-label="Decision in run"
          aria-valuetext={`Decision ${cursor} of ${range.max}`}
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
            title={`Indicator at D${indicatorAt}`}
          />
        )}
        {cueAt !== null && cueAt !== indicatorAt && (
          <span
            className="scrub-mark cue"
            style={{ left: percent(cueAt) }}
            title={`Cue at D${cueAt}`}
          />
        )}
        {contentAt !== null && (
          <span
            className="scrub-mark content"
            style={{ left: percent(contentAt) }}
            title={`Content at D${contentAt}`}
          />
        )}
      </div>
      <button
        disabled={disabled || cursor >= range.max}
        onClick={() => onChange(cursor + 1)}
        aria-label="Next decision"
      >
        ›
      </button>
      <span className="scrub-label">
        D{cursor} / {range.max}
      </span>
      <button
        onClick={() => onChange(range.max)}
        disabled={disabled || cursor === range.max}
      >
        End
      </button>
    </div>
  );
}
