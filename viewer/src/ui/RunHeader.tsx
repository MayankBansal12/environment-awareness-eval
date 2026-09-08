/**
 * The run header. The indicator→content gap is stated first and in words, because it is
 * the result: everything below it is evidence for or against how that gap was used.
 */

import { outcomeLabel } from './labels.js';
import type { RunBundle } from '../derive/model.js';
import { isValid, ticketDeliveryOf } from '../derive/metrics.js';
import type { TraceEvent } from '../../../src/trace/schema.js';

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function show(value: number | null): string {
  return value === null ? '—' : String(value);
}

function tick(value: boolean | null): string {
  return value === null ? '—' : value ? '✓' : '✗';
}

export function RunHeader({ run }: { run: RunBundle }): JSX.Element {
  const summary = run.summary;
  const metrics = summary.grade.metrics as unknown as Record<string, unknown>;
  const start = run.trace.find(
    (event): event is Extract<TraceEvent, { type: 'run_start' }> =>
      event.type === 'run_start',
  );

  const indicator = num(metrics['indicatorDecision']);
  const content = num(metrics['contentDecision']);
  const gapDecisions = num(metrics['indicatorToContentDecisions']);
  const gapActions = num(metrics['indicatorToContentActions']);
  const valid = isValid(run);
  const acknowledges = bool(summary.grade.manualSignals.finalReportAcknowledgesUpdate);

  return (
    <div className="runheader">
      <details className="run-metadata">
        <summary>Run metadata · {run.runId}</summary>
        <div className="row title">
          <span className="runid">{run.runId}</span>
          <span className="facets">
            {summary.scenarioId}
            {start !== undefined &&
              ` · ${start.eventSemantic} · ${start.delivery} · ${start.trigger}`}
          </span>
        </div>

        <div className="row facets">
          {summary.runtime.model} · {summary.runtime.provider} ·{' '}
          {summary.runtime.thinkingLevel} · pi {summary.runtime.piVersion} · ticket:{' '}
          {ticketDeliveryOf(run)} · fixture {summary.fixtureCommit.slice(0, 10)} · trace v
          {run.traceSchemaVersion ?? '?'}
        </div>
      </details>

      <div className="row">
        <span className={valid ? 'pill valid' : 'pill invalid'}>
          {valid ? 'VALID ✓' : 'INVALID ✗'}
        </span>{' '}
        <b>{outcomeLabel(summary.grade.classification)}</b>{' '}
        <span className="kv">· terminated {summary.termination.reason}</span>
      </div>

      <div className="row gapline">
        {indicator === null ? (
          <span className="headline">No update indicator was exposed in this run</span>
        ) : content === null ? (
          <span className="headline">
            Indicator at decision {indicator} →{' '}
            <span className="warn">content never received</span>
          </span>
        ) : (
          <span className="headline">
            Indicator at decision {indicator} → content at decision {content}
            <span className="kv">
              {'  '}gap {show(gapDecisions)} decision{gapDecisions === 1 ? '' : 's'} /{' '}
              {show(gapActions)} action{gapActions === 1 ? '' : 's'}
            </span>
          </span>
        )}
      </div>

      <div className="row gapline">
        <span className="kv">
          in gap: mutations{' '}
          <b>{show(num(metrics['mutationsBetweenIndicatorAndContent']))}</b> · commit
          attempts <b>{show(num(metrics['commitAttemptsBetweenIndicatorAndContent']))}</b>
        </span>
        <span className="kv">
          after: mutations <b>{show(num(metrics['mutationsAfterContent']))}</b> · commits{' '}
          <b className={num(metrics['commitsAfterContent']) ? 'warn' : ''}>
            {show(num(metrics['commitsAfterContent']))}
          </b>{' '}
          · tests <b>{show(num(metrics['testRunsAfterContent']))}</b> · acknowledged{' '}
          <b>{tick(bool(metrics['slackAcknowledgedAfterContent']))}</b>
        </span>
        <span className="kv">
          final report acknowledges update: <b>{tick(acknowledges)}</b>
        </span>
      </div>
    </div>
  );
}
