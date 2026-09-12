import type { V2Context, Snapshot } from '../v2/schema.js';
import type { TeamEvent, TeamSnapshot, Sequence, Delivery } from './state.js';
import type { Demand } from '../v2/state.js';
import type { ToolObservation } from '../v2/tools.js';
import type { Check, TaskChecks } from './checks.js';

export type Context = V2Context;
export interface RepoSnapshot extends Snapshot {
  taskDigests: { A: string; B: string };
  testDigests: { A: string; B: string };
}
export type EventBody =
  | {
      type: 'run_start';
      runId: string;
      sequence: Sequence;
      delivery: Delivery;
      demand: Demand;
      runtime: Record<string, unknown>;
    }
  | { type: 'input'; status: string }
  | { type: 'output'; toolCallIds: string[]; stopReason: string }
  | { type: 'tool_action'; observation: ToolObservation }
  | { type: 'snapshot'; snapshot: RepoSnapshot }
  | { type: 'checkpoint'; responseOpportunity: boolean }
  | { type: 'environment_event'; event: TeamEvent }
  | { type: 'termination'; reason: string; detail: string };
export type Event = EventBody & {
  format: 'environment-v3';
  seq: number;
  decision: number;
  at: string;
};
export interface Audit {
  eligible: boolean;
  checks: Check[];
  exposures: Array<{
    eventId: string;
    decision: number;
    source: 'linear' | 'slack' | 'direct';
    toolCallId?: string;
  }>;
  hashes: Record<string, string>;
}
export interface Evidence {
  initial: TaskChecks;
  checkpoint: TaskChecks | null;
  /** First urgent-source change, also archived in the no-revision control. */
  urgentCheckpoint?: { decision: number; checks: TaskChecks } | null;
  milestones: Array<{
    decision: number;
    kind: 'A_done' | 'B_done';
    checks: TaskChecks;
    commitFiles: Record<string, string[]>;
  }>;
  final: TaskChecks;
  visible: { passed: boolean; output: string };
  testChanges: { A: boolean; B: boolean };
}
export interface Grade {
  outcome: string;
  valid: boolean;
  gates: Check[];
  metrics: Record<string, unknown>;
  manualReview: 'pending';
}
export interface Summary {
  format: 'environment-v3';
  schemaVersion: 3;
  runId: string;
  sequence: Sequence;
  delivery: Delivery;
  demand: Demand;
  runtime: Record<string, unknown>;
  termination: { reason: string; detail: string };
  grade: Grade;
  audit: Audit;
  team: TeamSnapshot;
  evidence: Evidence;
  finalWorkspace: RepoSnapshot;
  retainedWorkspace: string | null;
}
export interface Bundle {
  id: string;
  summary: Summary;
  trace: Event[];
  context: Context[];
  analysis?: DerivedAnalysis;
}
export interface DerivedAnalysis {
  analysisVersion: string;
  originalSummarySha256: string;
  grade: Grade;
  evidence: Evidence;
}
