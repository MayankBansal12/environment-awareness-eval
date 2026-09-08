/**
 * The experiment engine.
 *
 * This is the whole protocol, and it is deliberately free of Pi-specific types so it can
 * be driven by the real adapter or by a fake sequence of events in tests.
 *
 * The decision-boundary contract, in order, per model decision opportunity:
 *
 *   1. The model emits one assistant turn / tool batch.
 *   2. Every already-issued tool in that batch settles (`observeTool` per tool).
 *   3. `settleTurn` records the actions and snapshots workspace/Git state.
 *   4. `settleTurn` evaluates semantic triggers and applies any pending environment event
 *      exactly once (posting to Slack, and for `steer` handing the text to the adapter).
 *   5. `decisionBoundary` exposes exactly one coherent current status, plus the full event
 *      only under `exposed` delivery.
 *   6. That model invocation is recorded as the first opportunity to perceive the change.
 *
 * Sibling tools in one parallel batch therefore cannot disagree: nothing is exposed while
 * a batch is in flight, and the status block is rendered once, at the boundary.
 */

import type { Scenario } from '../config/scenario-schema.js';
import {
  boundText,
  MAX_TOOL_OUTPUT_PREVIEW,
  traceEventSchema,
  TRACE_SCHEMA_VERSION,
  type TraceEvent,
  type TraceEventInput,
} from '../trace/schema.js';
import {
  captureText,
  MAX_ARGUMENT_TEXT,
  type CapturedMessage,
} from '../trace/model-call.js';
import type { WorkspaceSnapshot } from '../workspace/snapshot.js';
import {
  annotateMessages,
  anchorKeyFor,
  contextText,
  messageText,
  renderEventBlock,
  type AnchoredAnnotation,
  type AnnotatableMessage,
} from './environment.js';
import { SlackState, toView, type SlackMessage } from './slack.js';
import {
  classifyTestOutcome,
  isCommitCommand,
  isTestCommand,
  OneShotTrigger,
  type ObservedCommit,
  type ObservedTestRun,
} from './triggers.js';

export interface ToolObservation {
  toolCallId: string;
  toolName: string;
  batchId?: string;
  siblingOrdinal?: number;
  input: Record<string, unknown>;
  outputText: string;
  isError: boolean;
  blockedByHarness?: boolean;
  blockReason?: string;
}

export interface TurnSettlement {
  assistantText: string;
  /** Concatenated thinking blocks, when the provider returned any. */
  reasoningText?: string;
  /** True when a thinking block was redacted by a safety filter, carrying no plaintext. */
  reasoningRedacted?: boolean;
  /** Reasoning tokens billed for this turn, when the provider reports a breakdown. */
  reasoningTokens?: number;
  stopReason: string;
  toolCallNames: string[];
  /**
   * Tool calls with their full arguments, for the captured context only. `toolCallNames`
   * stays the trace's record; this is what makes the output side of a call readable, since
   * `inputSummary` reduces a `write` to a byte count.
   */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Token usage as the provider reported it. */
  usage?: Record<string, number>;
}

export interface StopDecision {
  stop: boolean;
  reason: 'max_turns' | 'max_actions';
  detail: string;
}

export interface EngineDeps {
  scenario: Scenario;
  slack: SlackState;
  /** Receives fully-formed trace events. */
  sink: (event: TraceEvent) => void;
  /** Snapshot the disposable workspace. Called once per settled turn. */
  snapshot: () => Promise<WorkspaceSnapshot>;
  /** Hand text to the runtime's own steering channel. Only used by `steer` delivery. */
  steer: (text: string) => Promise<void>;
  limits: { maxTurns: number; maxActions: number };
  /**
   * Receives the captured model context, when the run is capturing one. Optional because
   * the engine is driven by fakes in tests that have no interest in it, and because a
   * capture failure must never be able to fail a run.
   */
  captureSink?: (record: CaptureRecord) => void;
  /** Injected for determinism in tests. */
  now?: () => Date;
}

/** What the engine hands its capture sink. The writer stamps the schema version. */
export type CaptureRecord =
  | {
      type: 'call_input';
      decisionIndex: number;
      wallClockIso: string;
      capturedModelContext: CapturedMessage[];
      messageCount: number;
    }
  | {
      type: 'call_output';
      decisionIndex: number;
      turnIndex: number;
      wallClockIso: string;
      text: string;
      reasoningText?: string;
      reasoningRedacted?: boolean;
      stopReason: string;
      toolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        truncatedArguments: string[];
      }>;
      usage?: Record<string, number>;
    };

/** Per-turn accounting used by the awareness metrics. */
export interface TurnRecord {
  turnIndex: number;
  decisionIndex: number;
  mutatedSource: boolean;
  committed: boolean;
  ranTests: boolean;
  actionIndices: number[];
}

export interface EngineState {
  decisionIndex: number;
  actionIndex: number;
  turns: TurnRecord[];
  eventCreated:
    | { slackMessageId: string; atTurnIndex: number; atDecisionIndex: number; text: string }
    | undefined;
  indicatorExposedAtDecisionIndex: number | undefined;
  indicatorExposedAtActionIndex: number | undefined;
  contentExposedAtDecisionIndex: number | undefined;
  contentExposedAtActionIndex: number | undefined;
  contentExposureKind: 'content' | 'steer' | undefined;
  slackReadActions: Array<{
    actionIndex: number;
    decisionIndex: number;
    messageIds: string[];
  }>;
  slackPostActions: Array<{ actionIndex: number; decisionIndex: number; text: string }>;
  testRuns: ObservedTestRun[];
  commitAttempts: ObservedCommit[];
  ambientLeakDetected: boolean;
  triggerFiredAtTurn: number | undefined;
  eventCreationCount: number;
  finalAssistantText: string;
  snapshots: WorkspaceSnapshot[];
}

export class ExperimentEngine {
  readonly #deps: EngineDeps;
  readonly #trigger: OneShotTrigger;
  readonly #anchoredEvents: AnchoredAnnotation[] = [];

  #seq = 0;
  #decisionIndex = -1;
  #actionIndex = 0;
  #currentTurnActionIndices: number[] = [];
  #previousSnapshot: WorkspaceSnapshot | undefined;
  #pendingExposedText: string | undefined;
  #pendingExposureKind: 'content' | 'steer' | undefined;
  #pendingExposureSlackId: string | undefined;

  readonly #state: EngineState = {
    decisionIndex: -1,
    actionIndex: 0,
    turns: [],
    eventCreated: undefined,
    indicatorExposedAtDecisionIndex: undefined,
    indicatorExposedAtActionIndex: undefined,
    contentExposedAtDecisionIndex: undefined,
    contentExposedAtActionIndex: undefined,
    contentExposureKind: undefined,
    slackReadActions: [],
    slackPostActions: [],
    testRuns: [],
    commitAttempts: [],
    ambientLeakDetected: false,
    triggerFiredAtTurn: undefined,
    eventCreationCount: 0,
    finalAssistantText: '',
    snapshots: [],
  };

  constructor(deps: EngineDeps) {
    this.#deps = deps;
    this.#trigger = new OneShotTrigger(deps.scenario.trigger);
  }

  get state(): Readonly<EngineState> {
    return this.#state;
  }

  get decisionIndex(): number {
    return this.#decisionIndex;
  }

  get actionIndex(): number {
    return this.#actionIndex;
  }

  /**
   * The ordinal of the turn currently settling. Monotonic across session restarts, unlike
   * the runtime's own turn index — see `settleTurn`. Read by the adapter to name tool
   * batches, so siblings in one assistant message share an id that no later turn reuses.
   */
  get turnOrdinal(): number {
    return this.#state.turns.length;
  }

  // ---------------------------------------------------------------------------
  // Tracing
  // ---------------------------------------------------------------------------

  #nowIso(): string {
    return (this.#deps.now ?? (() => new Date()))().toISOString();
  }

  /**
   * Hands one record to the capture sink, swallowing anything it throws.
   *
   * The captured context is a diagnostic artifact. A run that produced a valid trace and a
   * gradeable result must not be failed retroactively because serializing its context
   * failed, so this is the one place in the engine that deliberately absorbs an error.
   */
  #capture(build: () => CaptureRecord): void {
    const sink = this.#deps.captureSink;
    if (sink === undefined) return;
    try {
      sink(build());
    } catch {
      // Intentionally ignored; see above.
    }
  }

  emit(event: TraceEventInput): void {
    const now = (this.#deps.now ?? (() => new Date()))();
    const complete = traceEventSchema.parse({
      ...event,
      schemaVersion: TRACE_SCHEMA_VERSION,
      seq: this.#seq++,
      decisionIndex: this.#decisionIndex,
      logicalActionIndex: this.#actionIndex,
      wallClockIso: now.toISOString(),
    });
    this.#deps.sink(complete as TraceEvent);
  }

  // ---------------------------------------------------------------------------
  // Step 5 + 6: the decision boundary
  // ---------------------------------------------------------------------------

  /**
   * Apply the environment surface to the context of one model call.
   *
   * Called immediately before every LLM request. Mutates and returns the supplied
   * message array, which the runtime hands over as a per-call copy.
   */
  decisionBoundary<T extends AnnotatableMessage>(messages: T[]): T[] {
    this.#decisionIndex += 1;
    this.#state.decisionIndex = this.#decisionIndex;

    // An `exposed` event queued at the previous turn boundary anchors to that turn's
    // final observation, so it stays in the same place for the rest of the run.
    if (
      this.#pendingExposedText !== undefined &&
      this.#pendingExposureKind === 'content' &&
      this.#pendingExposureSlackId !== undefined
    ) {
      const anchor = anchorKeyFor(messages);
      if (anchor !== 'none') {
        this.#anchoredEvents.push({
          anchor,
          block: this.#pendingExposedText,
          deliveredAtDecisionIndex: this.#decisionIndex,
          slackMessageId: this.#pendingExposureSlackId,
        });
        this.#pendingExposedText = undefined;
      }
    }

    const counts = this.#deps.slack.counts();
    const result = annotateMessages(messages, {
      counts,
      anchoredEvents: this.#anchoredEvents,
    });
    const authoritativeContentMessageIds = this.#authoritativeContentIds(result.messages);

    this.emit({
      type: 'decision_boundary',
      statusBlock: result.statusBlock ?? null,
      statusAnchor: result.statusAnchor,
      eventBlocks: result.appliedEventBlocks.map((annotation) => ({
        slackMessageId: annotation.slackMessageId,
        anchor: annotation.anchor,
        block: annotation.block,
      })),
      contextMessageCount: messages.length,
      slackUnread: counts.unread,
      slackMentions: counts.mentions,
      authoritativeContentMessageIds,
    });

    // Captured after annotation, so it is the array the runtime actually receives — the
    // status and event blocks are already appended to their anchors here. Guarded because
    // a capture failure must never take down a run that is otherwise fine.
    this.#capture(() => ({
      type: 'call_input',
      decisionIndex: this.#decisionIndex,
      wallClockIso: this.#nowIso(),
      capturedModelContext: result.messages.map(toCapturedMessage),
      messageCount: result.messages.length,
    }));

    this.#checkAmbientLeak(authoritativeContentMessageIds);
    this.#recordIndicatorExposure(counts.unread, counts.mentions, result.statusBlock);
    this.#recordPendingContentExposure(
      result.appliedEventBlocks.map((item) => item.slackMessageId),
      authoritativeContentMessageIds,
    );

    return result.messages;
  }

  #recordIndicatorExposure(
    unread: number,
    mentions: number,
    statusBlock: string | undefined,
  ): void {
    const created = this.#state.eventCreated;
    if (created === undefined) return;
    if (this.#state.indicatorExposedAtDecisionIndex !== undefined) return;
    if (unread === 0 && mentions === 0) return;
    if (statusBlock === undefined) return;

    this.#state.indicatorExposedAtDecisionIndex = this.#decisionIndex;
    this.#state.indicatorExposedAtActionIndex = this.#actionIndex;
    this.emit({
      type: 'environment_exposure',
      exposureKind: 'indicator',
      slackMessageId: created.slackMessageId,
      exposedText: statusBlock,
    });
  }

  #recordPendingContentExposure(
    appliedSlackIds: readonly string[],
    authoritativeContentMessageIds: readonly string[],
  ): void {
    if (this.#pendingExposureKind === undefined) return;
    if (this.#state.contentExposedAtDecisionIndex !== undefined) {
      this.#pendingExposureKind = undefined;
      this.#pendingExposureSlackId = undefined;
      return;
    }
    const placed =
      this.#pendingExposureSlackId !== undefined &&
      authoritativeContentMessageIds.includes(this.#pendingExposureSlackId) &&
      (this.#pendingExposureKind === 'steer' ||
        this.#deps.scenario.delivery === 'ambient' ||
        appliedSlackIds.includes(this.#pendingExposureSlackId));
    if (!placed) return;
    const created = this.#state.eventCreated;
    const exposureKind = this.#pendingExposureKind;
    this.#state.contentExposedAtDecisionIndex = this.#decisionIndex;
    this.#state.contentExposedAtActionIndex = this.#actionIndex;
    this.#state.contentExposureKind = exposureKind;
    this.emit({
      type: 'environment_exposure',
      exposureKind,
      slackMessageId: this.#pendingExposureSlackId ?? null,
      exposedText: created?.text ?? '',
    });
    this.#pendingExposureKind = undefined;
    this.#pendingExposureSlackId = undefined;
  }

  #authoritativeContentIds(messages: readonly AnnotatableMessage[]): string[] {
    const created = this.#state.eventCreated;
    if (created === undefined) return [];
    const probe = firstMeaningfulLine(created.text);
    if (probe.length === 0 || !contextText(messages).includes(probe)) return [];
    return [created.slackMessageId];
  }

  /**
   * Ambient delivery must expose counters only until a matching Slack read. Persisting the
   * content-presence ids at every boundary lets the post-run grader re-check this invariant.
   */
  #checkAmbientLeak(authoritativeContentMessageIds: readonly string[]): void {
    if (this.#deps.scenario.delivery !== 'ambient') return;
    const created = this.#state.eventCreated;
    if (created === undefined) return;
    if (!authoritativeContentMessageIds.includes(created.slackMessageId)) return;
    const matchingRead = this.#state.slackReadActions.some((read) =>
      read.messageIds.includes(created.slackMessageId),
    );
    if (!matchingRead) {
      this.#state.ambientLeakDetected = true;
      this.emit({
        type: 'harness_error',
        stage: 'ambient_leak',
        message:
          'authoritative event text was present in model context before read_slack_messages returned it',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2 + 3: tool observations
  // ---------------------------------------------------------------------------

  observeTool(observation: ToolObservation): number {
    const actionIndex = this.#actionIndex++;
    this.#state.actionIndex = this.#actionIndex;
    this.#currentTurnActionIndices.push(actionIndex);

    const command = observation.input['command'];
    const testOutcome =
      typeof command === 'string' && isTestCommand(command)
        ? classifyTestOutcome(observation.isError, observation.outputText)
        : undefined;

    this.emit({
      type: 'tool_action',
      actionIndex,
      toolCallId: observation.toolCallId,
      toolName: observation.toolName,
      ...(observation.batchId === undefined ? {} : { batchId: observation.batchId }),
      ...(observation.siblingOrdinal === undefined
        ? {}
        : { siblingOrdinal: observation.siblingOrdinal }),
      inputSummary: summarizeToolInput(observation.toolName, observation.input),
      isError: observation.isError,
      outputBytes: Buffer.byteLength(observation.outputText, 'utf8'),
      outputPreview: boundText(observation.outputText, MAX_TOOL_OUTPUT_PREVIEW),
      outputTruncated: observation.outputText.length > MAX_TOOL_OUTPUT_PREVIEW,
      outputChars: observation.outputText.length,
      ...(testOutcome === undefined ? {} : { observedTestOutcome: testOutcome }),
      blockedByHarness: observation.blockedByHarness === true,
      ...(observation.blockReason === undefined
        ? {}
        : { blockReason: observation.blockReason }),
    });

    if (typeof command === 'string') {
      if (testOutcome !== undefined) {
        this.#state.testRuns.push({
          actionIndex,
          turnIndex: this.#state.turns.length,
          command,
          outcome: testOutcome,
        });
      }
      if (isCommitCommand(command)) {
        this.#state.commitAttempts.push({
          actionIndex,
          turnIndex: this.#state.turns.length,
          command,
          succeeded: !observation.isError,
        });
      }
    }

    return actionIndex;
  }

  /** Record that `read_slack_messages` returned a batch. */
  observeSlackRead(
    actionIndex: number,
    messageIds: string[],
    readCursorAfter: number,
  ): void {
    this.#state.slackReadActions.push({
      actionIndex,
      decisionIndex: this.#decisionIndex,
      messageIds,
    });
    this.emit({
      type: 'slack_read',
      actionIndex,
      returnedMessageIds: messageIds,
      readCursorAfter,
    });

    const created = this.#state.eventCreated;
    if (
      created !== undefined &&
      messageIds.includes(created.slackMessageId) &&
      this.#state.contentExposedAtDecisionIndex === undefined
    ) {
      // Content becomes perceivable at the *next* decision boundary, not mid-batch.
      this.#pendingExposureKind = 'content';
      this.#pendingExposureSlackId = created.slackMessageId;
    }
  }

  observeSlackPost(actionIndex: number, messageId: string, text: string): void {
    this.#state.slackPostActions.push({
      actionIndex,
      decisionIndex: this.#decisionIndex,
      text,
    });
    this.emit({ type: 'slack_post', actionIndex, messageId, text: boundText(text, 2_000) });
    this.emit({
      type: 'slack_message',
      messageId,
      logicalTime: this.#decisionIndex,
      channel: this.#deps.slack.channel,
      sender: 'agent',
      senderRole: 'agent',
      text: boundText(text, 2_000),
      mentionsAgent: false,
      origin: 'agent',
    });
  }

  // ---------------------------------------------------------------------------
  // Step 3 + 4: turn settlement, triggers, event application
  // ---------------------------------------------------------------------------

  async settleTurn(turn: TurnSettlement): Promise<StopDecision | undefined> {
    // The engine's own turn ordinal, never the runtime's.
    //
    // Pi restarts `AssistantMessage.turnIndex` at 0 whenever a provider error forces a new
    // session, so two different turns in one run can carry the same runtime index. Turn
    // identity is load-bearing here — the trigger matches an observed test run to the turn
    // it ran in, the turn limit counts them, and the batch id names them — so it has to
    // come from a counter that only ever moves forward. `turns.length` is that counter,
    // and it reads as the ordinal of the turn now settling because the record for this
    // turn is pushed below.
    const turnIndex = this.#state.turns.length;
    this.#state.finalAssistantText = turn.assistantText;
    // Reasoning is omitted rather than emitted empty when the provider returned none, so
    // "this provider withheld it" stays distinguishable from "the model reasoned briefly".
    this.emit({
      type: 'assistant_turn',
      turnIndex,
      text: boundText(turn.assistantText, 4_000),
      ...(turn.reasoningText === undefined
        ? {}
        : { reasoningText: boundText(turn.reasoningText, 12_000) }),
      ...(turn.reasoningRedacted === undefined
        ? {}
        : { reasoningRedacted: turn.reasoningRedacted }),
      ...(turn.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: turn.reasoningTokens }),
      toolCallNames: turn.toolCallNames,
      stopReason: turn.stopReason,
    });

    this.#capture(() => ({
      type: 'call_output',
      decisionIndex: this.#decisionIndex,
      turnIndex,
      wallClockIso: this.#nowIso(),
      text: turn.assistantText,
      ...(turn.reasoningText === undefined ? {} : { reasoningText: turn.reasoningText }),
      ...(turn.reasoningRedacted === undefined
        ? {}
        : { reasoningRedacted: turn.reasoningRedacted }),
      stopReason: turn.stopReason,
      toolCalls: (turn.toolCalls ?? []).map(captureToolCall),
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
    }));

    const snapshot = await this.#deps.snapshot();
    this.#state.snapshots.push(snapshot);
    this.emit({
      type: 'workspace_snapshot',
      label: 'turn_end',
      turnIndex,
      headCommit: snapshot.headCommit,
      commitsAheadOfFixture: snapshot.commitsAheadOfFixture,
      sourceMutated: snapshot.sourceMutated,
      workingTreeDirty: snapshot.workingTreeDirty,
      statusPorcelain: boundText(snapshot.statusPorcelain, 4_000),
      trackedSourceDigest: snapshot.trackedSourceDigest,
      commits: snapshot.commits,
      changedWatchedFiles: snapshot.changedWatchedFiles,
      untrackedWatchedFiles: snapshot.untrackedWatchedFiles,
      changedFiles: snapshot.changedFiles,
      untrackedFiles: snapshot.untrackedFiles,
    });

    const previous = this.#previousSnapshot;
    const record: TurnRecord = {
      turnIndex,
      decisionIndex: this.#decisionIndex,
      mutatedSource:
        previous === undefined
          ? snapshot.sourceMutated
          : snapshot.trackedSourceDigest !== previous.trackedSourceDigest,
      committed:
        previous === undefined
          ? snapshot.commitsAheadOfFixture > 0
          : snapshot.commitsAheadOfFixture > previous.commitsAheadOfFixture,
      ranTests: this.#state.testRuns.some((run) =>
        this.#currentTurnActionIndices.includes(run.actionIndex),
      ),
      actionIndices: [...this.#currentTurnActionIndices],
    };
    this.#state.turns.push(record);
    this.#previousSnapshot = snapshot;
    this.#currentTurnActionIndices = [];

    await this.#maybeFireTrigger(snapshot, turnIndex);

    return this.#stopDecision(turnIndex);
  }

  async #maybeFireTrigger(snapshot: WorkspaceSnapshot, turnIndex: number): Promise<void> {
    const scenario = this.#deps.scenario;
    if (scenario.eventSemantic === 'none' || scenario.payload === undefined) return;

    const decision = this.#trigger.evaluate({
      snapshot,
      testRuns: this.#state.testRuns,
      commitAttempts: this.#state.commitAttempts,
      turnIndex,
    });
    if (decision === undefined) return;

    this.#state.triggerFiredAtTurn = turnIndex;
    this.emit({
      type: 'trigger_fired',
      trigger: scenario.trigger,
      turnIndex,
      evidence: decision.evidence,
    });

    await this.#applyEnvironmentEvent(turnIndex);
  }

  /** Creates the event exactly once and routes it through the configured delivery mode. */
  async #applyEnvironmentEvent(turnIndex: number): Promise<void> {
    const scenario = this.#deps.scenario;
    const payload = scenario.payload;
    if (payload === undefined) return;
    if (this.#state.eventCreated !== undefined) return;

    const message: SlackMessage = this.#deps.slack.post({
      sender: payload.sender,
      senderRole: payload.senderRole,
      text: payload.text,
      mentionsAgent: payload.mentionsAgent,
      logicalTime: this.#decisionIndex,
    });
    this.#state.eventCreationCount += 1;
    this.#state.eventCreated = {
      slackMessageId: message.id,
      atTurnIndex: turnIndex,
      atDecisionIndex: this.#decisionIndex,
      text: payload.text,
    };

    this.emit({
      type: 'environment_event_created',
      scenarioId: scenario.id,
      eventSemantic: scenario.eventSemantic,
      delivery: scenario.delivery,
      slackMessageId: message.id,
      text: payload.text,
    });

    this.emit({
      type: 'slack_message',
      messageId: message.id,
      logicalTime: message.logicalTime,
      channel: message.channel,
      sender: message.sender,
      senderRole: message.senderRole,
      text: message.text,
      mentionsAgent: message.mentionsAgent,
      origin: 'scenario',
    });

    let mechanism: 'slack_unread' | 'context_event' | 'pi_steer' = 'slack_unread';
    if (scenario.delivery === 'exposed') {
      mechanism = 'context_event';
      this.#pendingExposedText = renderEventBlock(toView(message));
      this.#pendingExposureKind = 'content';
      this.#pendingExposureSlackId = message.id;
    } else if (scenario.delivery === 'steer') {
      mechanism = 'pi_steer';
      // Steering is queued here and picked up by the runtime immediately after this turn
      // settles, so it lands before the next model call: the same boundary the other
      // delivery modes use.
      await this.#deps.steer(payload.text);
      this.#pendingExposureKind = 'steer';
      this.#pendingExposureSlackId = message.id;
      // A steered message is authoritative and already delivered, so it is not left
      // sitting unread in the channel.
      this.#deps.slack.markMessageRead(message.id);
    }

    this.emit({
      type: 'environment_delivery',
      scenarioId: scenario.id,
      eventSemantic: scenario.eventSemantic,
      delivery: scenario.delivery,
      slackMessageId: message.id,
      mechanism,
      intendedDecisionIndex: this.#decisionIndex + 1,
      intendedLogicalActionIndex: this.#actionIndex,
    });
  }

  #stopDecision(turnIndex: number): StopDecision | undefined {
    if (turnIndex + 1 >= this.#deps.limits.maxTurns) {
      return {
        stop: true,
        reason: 'max_turns',
        detail:
          'reached the configured maximum of ' + this.#deps.limits.maxTurns + ' turns',
      };
    }
    if (this.#actionIndex >= this.#deps.limits.maxActions) {
      return {
        stop: true,
        reason: 'max_actions',
        detail:
          'reached the configured maximum of ' +
          this.#deps.limits.maxActions +
          ' tool actions',
      };
    }
    return undefined;
  }
}

/** Keep only path/command metadata in the trace; never file bodies. */
/** Flattens one runtime message into the captured form, bounding its text. */
function toCapturedMessage(message: AnnotatableMessage): CapturedMessage {
  const captured = captureText(messageText(message));
  return {
    role: message.role,
    text: captured.text,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    truncated: captured.truncated,
    chars: captured.chars,
  };
}

/**
 * Bounds each string argument of a tool call, naming the ones that were cut.
 *
 * Non-string arguments pass through untouched: they are structural (edit ranges, flags)
 * and small, and rewriting them would change their type.
 */
function captureToolCall(call: {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}): {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  truncatedArguments: string[];
} {
  const bounded: Record<string, unknown> = {};
  const truncatedArguments: string[] = [];
  for (const [key, value] of Object.entries(call.arguments)) {
    if (typeof value !== 'string') {
      bounded[key] = value;
      continue;
    }
    const captured = captureText(value, MAX_ARGUMENT_TEXT);
    bounded[key] = captured.text;
    if (captured.truncated) truncatedArguments.push(key);
  }
  return { id: call.id, name: call.name, arguments: bounded, truncatedArguments };
}

export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ['path', 'pattern', 'glob', 'command']) {
    const value = input[key];
    if (typeof value === 'string') {
      summary[key] = boundText(value, 600);
    }
  }
  if (toolName === 'write' && typeof input['content'] === 'string') {
    summary['contentBytes'] = Buffer.byteLength(input['content'] as string, 'utf8');
  }
  if (toolName === 'edit' && Array.isArray(input['edits'])) {
    summary['editCount'] = (input['edits'] as unknown[]).length;
  }
  if (toolName === 'post_slack_message' && typeof input['text'] === 'string') {
    summary['text'] = boundText(input['text'] as string, 2_000);
  }
  return summary;
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length >= 24) return trimmed;
  }
  return text.trim();
}

export { SlackState };
