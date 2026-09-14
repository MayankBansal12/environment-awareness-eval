import type { Comparison, Manifest } from '../../src/experiment.js';
import type { CapturedMessage } from '../../src/harness/capture.js';
import type { Condition } from '../../src/scenario.js';
import type { Context, Event, Summary } from '../../src/schema.js';

/** One row of the run list; everything the list and its filters need without the run body. */
export interface RunRow {
  /** Path under results/, e.g. `load-sweep/runs/t001` or `dev/smoke`. */
  key: string;
  runId: string;
  experiment: string | null;
  condition: Condition;
  model: string;
  termination: string;
  valid: boolean;
  censored: boolean;
  decisions: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  importantFired: number;
  importantMissed: number;
}

export interface ExperimentEntry {
  id: string;
  profile: Manifest['design']['profile'];
  createdAt: string;
  comparison: Comparison;
}

export interface ViewerIndex {
  generatedAt: string;
  resultsDir: string;
  runs: RunRow[];
  experiments: ExperimentEntry[];
  skipped: Array<{ path: string; reason: string }>;
}

type Header = Extract<Context, { type: 'header' }>;
type AuditRecord = Extract<Context, { type: 'audit' }>;

/** A run body. Captured input messages are interned: each decision lists indices into `messages`. */
export interface RunDetail {
  key: string;
  summary: Summary;
  trace: Event[];
  header: Header | null;
  capture: AuditRecord | null;
  messages: CapturedMessage[];
  inputs: Record<number, number[]>;
  outputs: Record<number, CapturedMessage>;
}
