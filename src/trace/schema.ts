/**
 * Normalized trace event schema.
 *
 * The trace is the primary artifact: it must let a reader reconstruct, per decision
 * boundary, what the model could perceive and what it then did.
 *
 * Every event carries a logical `seq`, the `decisionIndex` (model decision opportunity)
 * and the `logicalActionIndex` (tool actions so far) it belongs to. Those logical indices
 * are the experiment's only notion of time. `wallClockIso` is recorded for diagnostics and
 * never drives a trigger or serves as a primary metric.
 *
 * The engine validates every event against this schema before it reaches the writer, so a
 * malformed trace fails the run rather than silently producing an unreadable artifact.
 */

import { z } from 'zod';

export const TRACE_SCHEMA_VERSION = 3;

/** Bounded text: raw command output is truncated before it reaches an artifact. */
export const MAX_TRACE_TEXT = 4_000;

export function boundText(value: string, limit: number = MAX_TRACE_TEXT): string {
  if (value.length <= limit) return value;
  const omitted = value.length - limit;
  return (
    value.slice(0, limit) + '\n… [' + omitted + ' characters omitted by the trace writer]'
  );
}

const baseFields = {
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  seq: z.number().int().nonnegative(),
  /** Model decision opportunity this event belongs to. -1 before the first model call. */
  decisionIndex: z.number().int(),
  /** Tool actions recorded so far. The experiment's action clock. */
  logicalActionIndex: z.number().int().nonnegative(),
  /** Diagnostic only. Never used for triggering or as a primary metric. */
  wallClockIso: z.string(),
};

const commitRecordSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  unixTime: z.number().int(),
});

export const traceEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseFields,
    type: z.literal('run_start'),
    runId: z.string(),
    scenarioId: z.string(),
    eventSemantic: z.string(),
    delivery: z.string(),
    trigger: z.string(),
    /** Where the ticket text arrived: unread Slack message, or the user prompt. */
    ticketDelivery: z.enum(['slack', 'direct']),
    provider: z.string(),
    model: z.string(),
    thinkingLevel: z.string(),
    piPackageVersion: z.string(),
    harnessVersion: z.string(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('fixture_prepared'),
    sourcePath: z.string(),
    sourceHeadCommit: z.string(),
    expectedCommit: z.string(),
    workspacePath: z.string(),
    workspaceHeadCommit: z.string(),
    /** True when the source fixture was at the pinned commit with a clean working tree. */
    cleanCheckout: z.boolean(),
    dependenciesInstalled: z.boolean().optional(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('system_prompt'),
    systemPrompt: z.string(),
    initialUserPrompt: z.string(),
    tools: z.array(z.string()),
    resourceIsolation: z.record(z.string(), z.boolean()),
  }),
  z.object({
    ...baseFields,
    type: z.literal('decision_boundary'),
    /** Exact `<environment_status>` text placed in this model call's context. */
    statusBlock: z.string().nullable(),
    statusAnchor: z.string(),
    /** Exact `<environment_event>` blocks present in this model call's context. */
    eventBlocks: z.array(
      z.object({ slackMessageId: z.string(), anchor: z.string(), block: z.string() }),
    ),
    contextMessageCount: z.number().int(),
    slackUnread: z.number().int(),
    slackMentions: z.number().int(),
    /** Scenario message ids whose authoritative text was actually present in context. */
    authoritativeContentMessageIds: z.array(z.string()),
  }),
  z.object({
    ...baseFields,
    type: z.literal('assistant_turn'),
    turnIndex: z.number().int(),
    text: z.string(),
    toolCallNames: z.array(z.string()),
    stopReason: z.string(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('tool_action'),
    actionIndex: z.number().int(),
    toolCallId: z.string(),
    toolName: z.string(),
    /** Correlates siblings issued in one parallel tool batch. */
    batchId: z.string().optional(),
    siblingOrdinal: z.number().int().optional(),
    /** Metadata only: paths and commands, never file bodies. */
    inputSummary: z.record(z.string(), z.unknown()),
    isError: z.boolean(),
    outputBytes: z.number().int(),
    outputPreview: z.string(),
    /** Normalized from the full output before trace truncation. Present for test commands. */
    observedTestOutcome: z.enum(['passed', 'failed', 'unknown']).optional(),
    blockedByHarness: z.boolean(),
    blockReason: z.string().optional(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('slack_read'),
    actionIndex: z.number().int(),
    returnedMessageIds: z.array(z.string()),
    readCursorAfter: z.number().int(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('slack_post'),
    actionIndex: z.number().int(),
    messageId: z.string(),
    text: z.string(),
  }),
  /** Full record of every message that ever entered the channel, for replay. */
  z.object({
    ...baseFields,
    type: z.literal('slack_message'),
    messageId: z.string(),
    logicalTime: z.number().int(),
    channel: z.string(),
    sender: z.string(),
    senderRole: z.string(),
    text: z.string(),
    mentionsAgent: z.boolean(),
    origin: z.enum(['initial', 'scenario', 'agent']),
  }),
  z.object({
    ...baseFields,
    type: z.literal('trigger_fired'),
    trigger: z.string(),
    turnIndex: z.number().int(),
    evidence: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ...baseFields,
    type: z.literal('environment_event_created'),
    scenarioId: z.string(),
    eventSemantic: z.string(),
    delivery: z.string(),
    slackMessageId: z.string(),
    /** The authoritative text, recorded once for reproducibility. */
    text: z.string(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('environment_delivery'),
    scenarioId: z.string(),
    eventSemantic: z.string(),
    delivery: z.string(),
    slackMessageId: z.string(),
    mechanism: z.enum(['slack_unread', 'context_event', 'pi_steer']),
    /** The decision at which the queued event is intended to become perceivable. */
    intendedDecisionIndex: z.number().int().nonnegative(),
    intendedLogicalActionIndex: z.number().int().nonnegative(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('environment_exposure'),
    exposureKind: z.enum(['indicator', 'content', 'steer']),
    slackMessageId: z.string().nullable(),
    /** Exact text made perceivable at this decision boundary. */
    exposedText: z.string(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('workspace_snapshot'),
    label: z.string(),
    turnIndex: z.number().int().nullable(),
    headCommit: z.string(),
    commitsAheadOfFixture: z.number().int(),
    sourceMutated: z.boolean(),
    workingTreeDirty: z.boolean(),
    statusPorcelain: z.string(),
    trackedSourceDigest: z.string(),
    commits: z.array(commitRecordSchema).optional(),
    changedWatchedFiles: z.array(z.string()).optional(),
    untrackedWatchedFiles: z.array(z.string()).optional(),
    /** Every tracked or untracked path differing from the fixture, repo-wide. */
    changedFiles: z.array(z.string()).optional(),
    untrackedFiles: z.array(z.string()).optional(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('termination'),
    reason: z.enum([
      'agent_finished',
      'max_turns',
      'max_actions',
      'timeout',
      'harness_error',
      'aborted',
    ]),
    detail: z.string(),
    finalAssistantText: z.string(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('harness_error'),
    stage: z.string(),
    message: z.string(),
  }),
]);

export type TraceEvent = z.infer<typeof traceEventSchema>;

/** What callers pass to `ExperimentEngine.emit`; the engine stamps the base fields. */
export type TraceEventInput = {
  [K in TraceEvent as K['type']]: Omit<K, keyof typeof baseFields>;
}[TraceEvent['type']];
