import { z } from 'zod';
import { capturedMessageSchema } from './harness/capture.js';
import type { Snapshot } from './harness/snapshot.js';
import type { ToolObservation } from './harness/repo-tools.js';
import type { Check } from './families/types.js';
import type { TaskChecks } from './checks.js';
import type { Condition, ImportantKind } from './scenario.js';
import type { TeamEvent, TeamSnapshot } from './state.js';
import type { UsageRecord, UsageTotals } from './usage.js';

export const FORMAT = 'environment-awareness-4';
export const contextSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('header'),
    systemPrompt: z.string(),
    tools: z.array(
      z.object({ name: z.string(), description: z.string(), parameters: z.unknown() }),
    ),
    runtime: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('input'),
    decision: z.number().int(),
    messages: z.array(capturedMessageSchema),
  }),
  z.object({
    type: z.literal('output'),
    decision: z.number().int(),
    message: capturedMessageSchema,
  }),
  z.object({
    type: z.literal('audit'),
    inputs: z.number().int(),
    outputs: z.number().int(),
    complete: z.boolean(),
    partialContent: z.boolean(),
    note: z.string(),
  }),
]);
export type Context = z.infer<typeof contextSchema>;

export interface RepoSnapshot extends Snapshot {
  focalDigest: string;
  hotfixDigest: string;
  testsDigest: string;
}

export type EventBody =
  | {
      type: 'run_start';
      runId: string;
      condition: Condition;
      runtime: Record<string, unknown>;
    }
  | { type: 'input'; status: string; counts: { linear: number; slack: number } }
  | {
      type: 'output';
      toolCallIds: string[];
      stopReason: string;
      usage: UsageRecord | null;
      errorMessage?: string;
    }
  | { type: 'tool_action'; observation: ToolObservation }
  | { type: 'snapshot'; snapshot: RepoSnapshot }
  | {
      type: 'environment_event';
      event: TeamEvent;
      trigger: {
        mode: 'condition' | 'fallback' | 'noise';
        when?: string;
        batchTestFailure: boolean;
        batchError: boolean;
      };
    }
  | {
      type: 'exposure';
      eventId: string;
      level: 'cue' | 'content';
      via: string;
      toolCallId?: string;
    }
  | {
      type: 'provider_retry';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: 'compaction';
      phase: 'start' | 'end';
      reason: string;
      aborted?: boolean;
      errorMessage?: string;
    }
  | { type: 'termination'; reason: string; detail: string };

export type Event = EventBody & {
  format: typeof FORMAT;
  seq: number;
  decision: number;
  at: string;
};

export interface Audit {
  eligible: boolean;
  checks: Check[];
  hashes: Record<string, string>;
}

export interface Evidence {
  initial: TaskChecks;
  /** Repository state archived at the decision each important event fired, probed afterwards. */
  atEvents: Array<{
    eventId: string;
    kind: ImportantKind;
    decision: number;
    checks: TaskChecks;
  }>;
  final: TaskChecks;
  visible: { passed: boolean; output: string };
  commitFiles: Record<string, string[]>;
}

export interface EventMetrics {
  kind: ImportantKind;
  eventId: string | null;
  fired: boolean;
  firedDecision: number | null;
  trigger: 'condition' | 'fallback' | null;
  firedDuringTestFailure: boolean | null;
  /** Context size of the model call that first saw the indicator (load covariate). */
  contextTokensAtFire: number | null;
  /** Focal checks still failing at fire time, under the spec in force then (load covariate). */
  focalChecksFailingAtFire: number | null;
  decisionsAfterFire: number | null;
  cueDecision: number | null;
  contentDecision: number | null;
  /** Decisions from the first input showing the indicator to content retrieval. */
  detectionLatency: number | null;
  missed: boolean | null;
  focalChangesBeforeContent: number | null;
  commitsBeforeContent: number | null;
  toolActionsBeforeContent: number | null;
  adapted: boolean | null;
}

export interface Grade {
  graderVersion: string;
  valid: boolean;
  censored: boolean;
  validity: Check[];
  events: EventMetrics[];
  urgent: Record<string, boolean | number | null>;
  outcome: Record<string, boolean | number>;
  summary: Record<string, number | null>;
  manualReview: 'pending';
}

export interface Summary {
  format: typeof FORMAT;
  schemaVersion: 4;
  runId: string;
  condition: Condition;
  runtime: Record<string, unknown>;
  termination: { reason: string; detail: string };
  usage: UsageTotals;
  durationMs: number;
  grade: Grade;
  audit: Audit;
  team: TeamSnapshot;
  evidence: Evidence;
  finalWorkspace: RepoSnapshot;
}
