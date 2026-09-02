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
  traceEventSchema,
  TRACE_SCHEMA_VERSION,
  type TraceEvent,
  type TraceEventInput,
} from '../trace/schema.js';
import type { WorkspaceSnapshot } from '../workspace/snapshot.js';
import {
  annotateMessages,
  anchorKeyFor,
  contextText,
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
  turnIndex: number;
  assistantText: string;
  stopReason: string;
  toolCallNames: string[];
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
  /** Injected for determinism in tests. */
  now?: () => Date;
}

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

  // ---------------------------------------------------------------------------
  // Tracing
  // ---------------------------------------------------------------------------

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
    });

    this.#recordIndicatorExposure(counts.unread, counts.mentions, result.statusBlock);
    this.#recordPendingContentExposure(
      result.appliedEventBlocks.map((item) => item.slackMessageId),
    );
    this.#checkAmbientLeak(result.messages);

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

  #recordPendingContentExposure(appliedSlackIds: readonly string[]): void {
    if (this.#pendingExposureKind === undefined) return;
    if (this.#state.contentExposedAtDecisionIndex !== undefined) {
      this.#pendingExposureKind = undefined;
      this.#pendingExposureSlackId = undefined;
      return;
    }
    const placed =
      this.#pendingExposureKind === 'steer' ||
      (this.#pendingExposureKind === 'content' &&
        this.#deps.scenario.delivery === 'ambient') ||
      (this.#pendingExposureSlackId !== undefined &&
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

  /**
   * Ambient delivery must expose counters only. If the authoritative text ever appears in
   * the model's context before the agent reads Slack, the run is invalid.
   */
  #checkAmbientLeak(messages: readonly AnnotatableMessage[]): void {
    if (this.#deps.scenario.delivery !== 'ambient') return;
    const created = this.#state.eventCreated;
    if (created === undefined) return;
    if (this.#state.contentExposedAtDecisionIndex !== undefined) return;
    const probe = firstMeaningfulLine(created.text);
    if (probe.length === 0) return;
    if (contextText(messages).includes(probe)) {
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
      outputPreview: boundText(observation.outputText, 1_500),
      blockedByHarness: observation.blockedByHarness === true,
      ...(observation.blockReason === undefined
        ? {}
        : { blockReason: observation.blockReason }),
    });

    const command = observation.input['command'];
    if (typeof command === 'string') {
      if (isTestCommand(command)) {
        const outcome = classifyTestOutcome(observation.isError, observation.outputText);
        this.#state.testRuns.push({
          actionIndex,
          turnIndex: this.#state.turns.length,
          command,
          outcome,
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
    this.#state.finalAssistantText = turn.assistantText;
    this.emit({
      type: 'assistant_turn',
      turnIndex: turn.turnIndex,
      text: boundText(turn.assistantText, 4_000),
      toolCallNames: turn.toolCallNames,
      stopReason: turn.stopReason,
    });

    const snapshot = await this.#deps.snapshot();
    this.#state.snapshots.push(snapshot);
    this.emit({
      type: 'workspace_snapshot',
      label: 'turn_end',
      turnIndex: turn.turnIndex,
      headCommit: snapshot.headCommit,
      commitsAheadOfFixture: snapshot.commitsAheadOfFixture,
      sourceMutated: snapshot.sourceMutated,
      workingTreeDirty: snapshot.workingTreeDirty,
      statusPorcelain: boundText(snapshot.statusPorcelain, 4_000),
      trackedSourceDigest: snapshot.trackedSourceDigest,
      commits: snapshot.commits,
      changedWatchedFiles: snapshot.changedWatchedFiles,
      untrackedWatchedFiles: snapshot.untrackedWatchedFiles,
    });

    const previous = this.#previousSnapshot;
    const record: TurnRecord = {
      turnIndex: turn.turnIndex,
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

    await this.#maybeFireTrigger(snapshot, turn.turnIndex);

    return this.#stopDecision(turn.turnIndex);
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

    if (scenario.delivery === 'exposed') {
      this.#pendingExposedText = renderEventBlock(toView(message));
      this.#pendingExposureKind = 'content';
      this.#pendingExposureSlackId = message.id;
      return;
    }

    if (scenario.delivery === 'steer') {
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
