/**
 * The shape of the payload the build step inlines into the single-file bundle, plus the
 * derived view types the UI renders. Trace events reuse the harness's own `TraceEvent`
 * union and summaries reuse `EvalSummary`; nothing is restated here.
 */

import type { EvalSummary } from '../../../src/runner.js';
import type { TraceEvent } from '../../../src/trace/schema.js';
import type { ContextBundle } from './context.js';
import type { SupportedTraceSchemaVersion, TicketDelivery } from './trace-compat.js';

/** A note the build step could not resolve but that must not be silently swallowed. */
export interface LoadWarning {
  runId: string;
  kind:
    | 'summary_schema_version'
    | 'missing_artifact'
    | 'summary_unreadable'
    | 'mixed_trace_versions'
    | 'context_unreadable';
  message: string;
}

export interface RunBundle {
  runId: string;
  summary: EvalSummary;
  trace: TraceEvent[];
  reportMd: string;
  diff: string;
  /** `/tmp/eaw-run-.../workspace`, taken from `fixture_prepared`. Stripped from paths. */
  workspacePath: string | null;
  /**
   * The version the trace was written at, before normalization onto the local schema.
   * Surfaced in the run index so a mixed corpus stays legible.
   */
  traceSchemaVersion: SupportedTraceSchemaVersion | null;
  /**
   * Resolved once at load: `summary.ticketDelivery`, else `run_start.ticketDelivery`,
   * else `slack` for runs that predate the field entirely.
   */
  ticketDelivery: TicketDelivery;
  /**
   * The captured model context, keyed by decision. Always present; a run with no
   * `context.jsonl` carries a bundle whose fidelity level is `none` and which says so.
   * Bodies are interned into `ViewerData.blobs` rather than inlined here.
   */
  context: ContextBundle;
}

/**
 * A run the loader could not parse. A mixed-generation corpus is the normal case, so one
 * unreadable run must never stop the other 36 from rendering — it is quarantined, shown in
 * the index with its reason, and excluded from every aggregate.
 */
export interface QuarantinedRun {
  runId: string;
  /** The version the trace claimed, when it was legible enough to read one. */
  claimedVersion: number | null;
  reason: string;
}

export interface ViewerData {
  generatedAtIso: string;
  resultsDir: string;
  /** The version of `traceEventSchema` the build validated against. */
  localTraceSchemaVersion: number;
  runs: RunBundle[];
  /** Runs that could not be parsed. Listed in the index, excluded from aggregates. */
  quarantined: QuarantinedRun[];
  warnings: LoadWarning[];
  /**
   * Every captured-context body, content-addressed and shared across all runs.
   *
   * Captured context is quadratic in a run's length and near-identical between adjacent
   * decisions, so inlining it would multiply the bundle. One shared table keyed by content
   * turns that back into roughly linear, and makes the identical system prompt across a
   * whole sweep cost one copy.
   */
  blobs: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Derived timeline types                                                      */
/* -------------------------------------------------------------------------- */

export type PhaseKind =
  'explore' | 'modify' | 'inspect' | 'report' | 'test' | 'commit' | 'shell';

export type TestOutcomeLabel = 'passed' | 'failed' | 'unknown';

/** One tool call, with everything the timeline needs precomputed. */
export interface ActionRow {
  kind: 'action';
  actionIndex: number;
  decisionIndex: number;
  seq: number;
  toolName: string;
  phase: PhaseKind;
  /** Human summary derived from `inputSummary`, e.g. `edit ledger-store.ts`. */
  label: string;
  /** The primary path, workspace-prefix stripped, or null. */
  path: string | null;
  detail: string | null;
  isError: boolean;
  blockedByHarness: boolean;
  testOutcome: TestOutcomeLabel | null;
  batchId: string | null;
  siblingOrdinal: number | null;
  /** True when this action shares its batch with at least one sibling. */
  inParallelBatch: boolean;
  outputPreview: string;
  outputBytes: number;
  event: TraceEvent;
}

/** A run of consecutive same-phase actions, collapsed for the digest zoom. */
export interface PhaseBand {
  kind: 'band';
  phase: PhaseKind;
  fromDecision: number;
  toDecision: number;
  actions: ActionRow[];
  /** e.g. `3 ls, 2 read` */
  composition: string;
  /** e.g. `README, package.json` or `src/ (7 files)` */
  targets: string;
}

export type MarkerKind =
  'trigger' | 'indicator' | 'content' | 'steer' | 'termination' | 'event_created';

export interface MarkerRow {
  kind: 'marker';
  marker: MarkerKind;
  decisionIndex: number;
  seq: number;
  title: string;
  detail: string;
  event: TraceEvent;
}

export type TimelineRow = ActionRow | PhaseBand | MarkerRow;

/** Workspace state as of a decision, from the nearest preceding snapshot. */
export interface WorkspaceState {
  sourceMutated: boolean;
  workingTreeDirty: boolean;
  commitsAheadOfFixture: number;
}
