/**
 * Everything the run index shows comes from `summary.json` — `grade.metrics`,
 * `grade.classification`, `grade.valid`. Nothing here recomputes a grade; the viewer
 * reports the harness's verdict, it does not form its own.
 *
 * An invalid run is a hard filter: per docs/scenarios.md an invalid run says nothing about
 * the model, so it must never reach an aggregate.
 */

import type { EvalSummary } from '../../../src/runner.js';
import type { RunBundle } from './model.js';
import {
  DEFAULT_TICKET_DELIVERY,
  type TicketDelivery,
} from './trace-compat.js';

export { DEFAULT_TICKET_DELIVERY };
export type { TicketDelivery };

/**
 * `ticketDelivery` is resolved once at load time — summary field, else `run_start`, else
 * the documented `slack` default for runs that predate the field entirely — so the UI
 * reads it off the bundle rather than re-deriving it per call site.
 */
export function ticketDeliveryOf(run: RunBundle): TicketDelivery {
  return run.ticketDelivery;
}

/**
 * The round a run belongs to. Repeats of one cell are distinguished only by run id, so the
 * round is read from an `r<n>` segment when the id carries one (`muse-r1-cancel-ambient`).
 * Runs without one fall back to their ordinal within the cell, which keeps repeats in
 * separate columns even for ids that encode nothing.
 */
export function roundFromRunId(runId: string): number | null {
  const match = /(?:^|[-_])r(\d+)(?:[-_]|$)/i.exec(runId);
  if (match === null || match[1] === undefined) return null;
  const round = Number.parseInt(match[1], 10);
  return Number.isFinite(round) && round > 0 ? round : null;
}

/** A cell of the run index: one scenario × ticket delivery, holding its repeats. */
export interface IndexCell {
  scenarioId: string;
  ticketDelivery: TicketDelivery;
  model: string;
  runs: { round: number; run: RunBundle }[];
}

export function groupRuns(runs: readonly RunBundle[]): IndexCell[] {
  const cells = new Map<string, IndexCell>();
  for (const run of runs) {
    const ticketDelivery = ticketDeliveryOf(run);
    const model = run.summary.runtime.model;
    const key = `${model}|${run.summary.scenarioId}|${ticketDelivery}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { scenarioId: run.summary.scenarioId, ticketDelivery, model, runs: [] };
      cells.set(key, cell);
    }
    cell.runs.push({ round: 0, run });
  }
  for (const cell of cells.values()) {
    cell.runs.sort((a, b) => a.run.runId.localeCompare(b.run.runId));
    cell.runs.forEach((entry, index) => {
      entry.round = roundFromRunId(entry.run.runId) ?? index + 1;
    });
    cell.runs.sort((a, b) => a.round - b.round);
  }
  return [...cells.values()].sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      a.scenarioId.localeCompare(b.scenarioId) ||
      a.ticketDelivery.localeCompare(b.ticketDelivery),
  );
}

function formatOptional(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value);
}

/** `IND→CON` — decisions / actions from indicator exposure to content exposure. */
export function formatIndicatorToContent(metrics: EvalSummary['grade']['metrics']): string {
  const record = metrics as unknown as Record<string, number | boolean | null | undefined>;
  const indicator = record['indicatorDecision'];
  const decisions = record['indicatorToContentDecisions'];
  const actions = record['indicatorToContentActions'];
  // No indicator at all (baseline, or an event that never fired) is a different fact from
  // an indicator that was never followed by content exposure.
  if (indicator === null || indicator === undefined) return '—';
  if (decisions === null || decisions === undefined) return 'never';
  return `${formatOptional(decisions as number)} / ${formatOptional(actions as number)}`;
}

/** `AFTER` — mutations · commits after content exposure. */
export function formatAfterContent(metrics: EvalSummary['grade']['metrics']): string {
  const record = metrics as unknown as Record<string, number | boolean | null | undefined>;
  const mutations = record['mutationsAfterContent'];
  const commits = record['commitsAfterContent'];
  if (
    (mutations === null || mutations === undefined) &&
    (commits === null || commits === undefined)
  ) {
    return '—';
  }
  return `${formatOptional(mutations as number)} · ${formatOptional(commits as number)}`;
}

/** A run that committed after the content was in context is the headline failure. */
export function committedAfterContent(summary: EvalSummary): boolean {
  const record = summary.grade.metrics as unknown as Record<string, number | null | undefined>;
  const commits = record['commitsAfterContent'];
  return typeof commits === 'number' && commits > 0;
}

export function mutatedAfterContent(summary: EvalSummary): boolean {
  const record = summary.grade.metrics as unknown as Record<string, number | null | undefined>;
  const mutations = record['mutationsAfterContent'];
  return typeof mutations === 'number' && mutations > 0;
}

/** The validity gate. Invalid runs are struck through and excluded from every aggregate. */
export function isValid(run: RunBundle): boolean {
  return run.summary.grade.valid === true;
}

export interface Aggregate {
  total: number;
  valid: number;
  byClassification: { classification: string; count: number }[];
}

/** Aggregates over valid runs only. */
export function aggregate(runs: readonly RunBundle[]): Aggregate {
  const valid = runs.filter(isValid);
  const counts = new Map<string, number>();
  for (const run of valid) {
    const key = run.summary.grade.classification;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    total: runs.length,
    valid: valid.length,
    byClassification: [...counts.entries()]
      .map(([classification, count]) => ({ classification, count }))
      .sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification)),
  };
}
