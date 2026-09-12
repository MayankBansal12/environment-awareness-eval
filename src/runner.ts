import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import type { RunConfig } from './config/run-config.js';

import { ExperimentEngine, SlackState } from './engine/experiment.js';
import {
  parsePersistedRunEvidence,
  type CheckStatus,
  type PersistedRunEvidence,
} from './grading/artifact-evidence.js';
import { gradeRun, type GradeResult } from './grading/grader.js';
import { runHiddenRefundChecks } from './grading/hidden-checks.js';
import { runClaudeAgentWithSlack } from './claude/adapter.js';
import { runPiAgentWithSlack } from './pi/adapter.js';
import { buildInitialUserPrompt, buildSystemPrompt } from './prompt/system-prompt.js';
import { getScenario, isScenarioSupported } from './scenarios/catalog.js';
import { TICKET_MESSAGE } from './scenarios/messages.js';
import {
  MAX_RECORDED_FAILURES,
  MODEL_CALL_SCHEMA_VERSION,
  type CaptureFailure,
  type SystemPromptSource,
} from './trace/model-call.js';
import { redactMetadata } from './trace/redact.js';
import { TRACE_SCHEMA_VERSION } from './trace/schema.js';
import { ModelCallWriter, TraceWriter, redactSecrets, writeJson } from './trace/writer.js';
import { runCommand } from './workspace/git.js';
import {
  disposeWorkspace,
  prepareWorkspace,
  verifyFixture,
  writeRetentionMarker,
} from './workspace/manager.js';
import { fullDiffVsFixture, takeSnapshot } from './workspace/snapshot.js';

/** Bumped whenever the harness changes in a way that affects trace interpretation. */
export const HARNESS_VERSION = '0.2.0';

export interface RunArtifacts {
  runDir: string;
  tracePath: string;
  /** `context.jsonl` — the captured model context, written beside the trace. */
  contextPath: string;
  summaryPath: string;
  reportPath: string;
  diffPath: string;
}
/**
 * How complete this run's `context.jsonl` is.
 *
 * Carried in the summary so the completeness of the diagnostic artifact is inspectable
 * without opening the sidecar, and kept strictly beside `grade` rather than inside it: a
 * capture failure says something about the harness, never about the agent, and must not be
 * able to move a behavioural result in either direction.
 */
export interface CaptureAudit {
  schemaVersion: number;
  contextPath: string;
  headerWritten: boolean;
  inputCount: number;
  outputCount: number;
  traceDecisionCount: number;
  decisionsMissingInput: number[];
  decisionsMissingOutput: number[];
  failures: CaptureFailure[];
  failureCount: number;
  truncatedMessageCount: number;
  redactedMessageCount: number;
  omittedBlockMessageCount: number;
  systemPromptSource: SystemPromptSource | null;
  complete: boolean;
  note: string;
}

export interface EvalSummary {
  schemaVersion: 4;
  runId: string;
  scenarioId: string;
  ticketDelivery: RunConfig['ticketDelivery'];
  runtime: {
    provider: string;
    model: string;
    thinkingLevel: string;
    piVersion: string;
    runtimeVersion?: string;
    runtimeKind?: string;
  };
  fixtureCommit: string;
  termination: { reason: string; detail: string };
  grade: GradeResult;
  finalWorkspace: PersistedRunEvidence['finalWorkspace'];
  visibleTests: PersistedRunEvidence['visibleTests'];
  hiddenChecks: PersistedRunEvidence['hiddenChecks'];
  artifacts: RunArtifacts;
  retainedWorkspace: string | null;
  /** Diagnostic completeness of the captured model context. Never an input to grading. */
  capture: CaptureAudit;
}
function overlaps(a: string, b: string): boolean {
  const x = path.resolve(a),
    y = path.resolve(b),
    xy = path.relative(x, y),
    yx = path.relative(y, x);
  return (
    xy === '' ||
    (!xy.startsWith('..') && !path.isAbsolute(xy)) ||
    (!yx.startsWith('..') && !path.isAbsolute(yx))
  );
}
function commandStatus(exitCode: number): CheckStatus {
  return exitCode === 0 ? 'passed' : 'failed';
}
function report(summary: EvalSummary): string {
  // The report is a human-readable digest. Full detail stays in summary.json and the
  // trace; command output is never dumped here at length.
  const line = (detail: string): string => {
    const collapsed = detail.replace(/\s+/g, ' ').trim();
    return collapsed.length > 160 ? collapsed.slice(0, 160) + '…' : collapsed;
  };
  const section = (items: GradeResult['validity']) =>
    items.map((x) => `- [${x.passed ? 'x' : ' '}] ${x.id}: ${line(x.detail)}`).join('\n');
  return `# Environment-awareness eval run

- Run: \`${summary.runId}\`
- Scenario: \`${summary.scenarioId}\`
- Ticket delivery: \`${summary.ticketDelivery}\`
- Runtime: \`${summary.runtime.provider}/${summary.runtime.model}\` (${summary.runtime.thinkingLevel})
- Classification: \`${summary.grade.classification}\`
- Valid: \`${summary.grade.valid}\`

## Validity
${section(summary.grade.validity)}

## Outcome
${section(summary.grade.outcome)}

## Metrics
\`\`\`json
${JSON.stringify(summary.grade.metrics, null, 2)}
\`\`\`

## Context capture (diagnostic — not part of the grade)
- Complete: \`${summary.capture.complete}\` (schema v${summary.capture.schemaVersion})
- Calls: ${summary.capture.inputCount} input / ${summary.capture.outputCount} output over ${summary.capture.traceDecisionCount} decision boundaries
- System prompt: \`${summary.capture.systemPromptSource ?? 'not captured'}\`
- ${line(summary.capture.note)}

This is a model + runtime + prompt + tools trajectory, not a claim about internal cognition.
`;
}
function assertControlled(config: RunConfig): void {
  if (overlaps(config.fixturePath, config.resultsDir))
    throw new Error('fixture and results directories must be disjoint');
}
export async function validateDryRun(
  config: RunConfig,
): Promise<{ scenarioId: string; fixtureCommit: string; workspacePrepared: boolean }> {
  const scenario = getScenario(config.scenarioId);
  if (!isScenarioSupported(scenario))
    throw new Error(scenario.unsupportedReason ?? 'scenario is unsupported');
  assertControlled(config);
  const workspace = await prepareWorkspace({
    sourcePath: config.fixturePath,
    expectedCommit: config.fixtureCommit,
    runId: config.runId,
    ...(config.workspaceRoot === undefined ? {} : { rootDir: config.workspaceRoot }),
    dependencyMode: config.dependencyMode,
  });
  await disposeWorkspace(workspace.path);
  return {
    scenarioId: scenario.id,
    fixtureCommit: workspace.headCommit,
    workspacePrepared: true,
  };
}
/**
 * States what the capture achieved, in the terms a reader needs to trust or discount it.
 *
 * `complete` is deliberately strict. It is false whenever the header is missing, anything
 * failed, or a decision the trace recorded has no captured input — the cases where the
 * sidecar cannot answer "what did the model see at Dn" for some n. A *missing output* does
 * not by itself make the capture incomplete: an aborted, timed-out or provider-failed run
 * genuinely has a last decision the model never answered, and calling the artifact broken
 * for faithfully recording that would be the wrong signal.
 */
export function buildCaptureAudit(input: {
  contextPath: string;
  stats: {
    headerWritten: boolean;
    inputDecisions: readonly number[];
    outputDecisions: readonly number[];
  };
  engine: {
    failures: readonly CaptureFailure[];
    failureCount: number;
    truncatedMessageCount: number;
    redactedMessageCount: number;
    omittedBlockMessageCount: number;
  };
  runnerFailures: readonly CaptureFailure[];
  traceDecisionCount: number;
  traceDecisions?: readonly number[];
  traceOutputDecisions?: readonly number[];
  systemPromptSource: SystemPromptSource | null;
}): CaptureAudit {
  const inputs = new Set(input.stats.inputDecisions);
  const outputs = new Set(input.stats.outputDecisions);
  const expectedInputs = new Set(
    input.traceDecisions ?? Array.from({ length: input.traceDecisionCount }, (_, i) => i),
  );
  const decisionsMissingInput = [...new Set([...expectedInputs, ...outputs])]
    .filter((d) => !inputs.has(d))
    .sort((a, b) => a - b);
  const decisionsMissingOutput = [...inputs]
    .filter((d) => !outputs.has(d))
    .sort((a, b) => a - b);

  const failureCount = input.engine.failureCount + input.runnerFailures.length;
  const failures = [...input.runnerFailures, ...input.engine.failures].slice(
    0,
    MAX_RECORDED_FAILURES,
  );

  const missingBoundaries = [...expectedInputs].filter((d) => !inputs.has(d)).length;
  const unexpectedInputs = [...inputs].filter((d) => !expectedInputs.has(d));
  const missingSettledOutputs = (input.traceOutputDecisions ?? []).filter(
    (d) => !outputs.has(d),
  );
  const duplicateRecords =
    inputs.size !== input.stats.inputDecisions.length ||
    outputs.size !== input.stats.outputDecisions.length;
  const complete =
    input.stats.headerWritten &&
    failureCount === 0 &&
    decisionsMissingInput.length === 0 &&
    missingBoundaries === 0 &&
    unexpectedInputs.length === 0 &&
    missingSettledOutputs.length === 0 &&
    !duplicateRecords;

  const notes: string[] = [];
  if (duplicateRecords) notes.push('duplicate captured decision records');
  if (unexpectedInputs.length)
    notes.push(`inputs without trace boundaries at D${unexpectedInputs.join(', D')}`);
  if (missingSettledOutputs.length)
    notes.push(
      `settled turns missing captured output at D${missingSettledOutputs.join(', D')}`,
    );
  if (!input.stats.headerWritten) {
    notes.push(
      'no capture_header: capture failed or the run ended before its session existed',
    );
  }
  if (missingBoundaries > 0) {
    notes.push(
      `${missingBoundaries} of ${input.traceDecisionCount} decision boundaries in the ` +
        'trace have no captured input',
    );
  }
  if (decisionsMissingInput.length > 0) {
    notes.push(`captured an output with no input at D${decisionsMissingInput.join(', D')}`);
  }
  if (decisionsMissingOutput.length > 0) {
    notes.push(
      `no captured output at D${decisionsMissingOutput.join(', D')} — expected for the ` +
        'final decision of a run that was aborted, timed out or lost its provider',
    );
  }
  if (failureCount > 0) notes.push(`${failureCount} capture failure(s)`);
  if (input.systemPromptSource === 'harness_configured') {
    notes.push(
      'system prompt is the harness-configured text, not the effective runtime prompt',
    );
  }

  return {
    schemaVersion: MODEL_CALL_SCHEMA_VERSION,
    contextPath: input.contextPath,
    headerWritten: input.stats.headerWritten,
    inputCount: input.stats.inputDecisions.length,
    outputCount: input.stats.outputDecisions.length,
    traceDecisionCount: input.traceDecisionCount,
    decisionsMissingInput,
    decisionsMissingOutput,
    failures,
    failureCount,
    truncatedMessageCount: input.engine.truncatedMessageCount,
    redactedMessageCount: input.engine.redactedMessageCount,
    omittedBlockMessageCount: input.engine.omittedBlockMessageCount,
    systemPromptSource: input.systemPromptSource,
    complete,
    note: notes.length === 0 ? 'every decision boundary captured' : notes.join('; '),
  };
}

export async function runEvaluation(config: RunConfig): Promise<EvalSummary> {
  const scenario = getScenario(config.scenarioId);
  if (!isScenarioSupported(scenario))
    throw new Error(scenario.unsupportedReason ?? 'scenario is unsupported');
  assertControlled(config);
  const runDir = path.join(config.resultsDir, config.runId);
  await mkdir(runDir, { recursive: true });
  const trace = await TraceWriter.create(runDir);
  const captureFailures: CaptureFailure[] = [];
  let capture: ModelCallWriter | undefined;
  const contextPath = path.join(runDir, 'context.jsonl');
  try {
    capture = await ModelCallWriter.create(runDir);
  } catch (error) {
    captureFailures.push({
      stage: 'capture_header',
      decisionIndex: null,
      message: redactSecrets(String(error)).slice(0, 1000),
    });
  }
  const artifacts: RunArtifacts = {
    runDir,
    tracePath: trace.path,
    summaryPath: path.join(runDir, 'summary.json'),
    reportPath: path.join(runDir, 'report.md'),
    diffPath: path.join(runDir, 'workspace.diff'),
    contextPath,
  };
  const prepared = await prepareWorkspace({
    sourcePath: config.fixturePath,
    expectedCommit: config.fixtureCommit,
    runId: config.runId,
    ...(config.workspaceRoot === undefined ? {} : { rootDir: config.workspaceRoot }),
    dependencyMode: config.dependencyMode,
  });
  if (overlaps(prepared.path, runDir)) {
    await disposeWorkspace(prepared.path);
    throw new Error('workspace and results directories must be disjoint');
  }
  const slack = new SlackState();
  const initialMessage = slack.post({
    sender: TICKET_MESSAGE.sender,
    senderRole: TICKET_MESSAGE.senderRole,
    text: TICKET_MESSAGE.text,
    mentionsAgent: TICKET_MESSAGE.mentionsAgent,
    logicalTime: -1,
  });
  if (config.ticketDelivery === 'direct') {
    // Recorded in channel history for trace completeness only: `read_slack_messages`
    // returns unread messages, so a direct-mode agent that opens Slack observes an
    // empty channel at t=0, not this ticket. Starting it already read keeps the badge
    // at zero so the baseline stays comparable across delivery modes. The tool surface
    // itself is identical in both modes; see docs/limitations.md.
    slack.markMessageRead(initialMessage.id);
  }
  let steer: ((text: string) => Promise<void>) | undefined;
  // Capture bookkeeping that lives outside the engine: the header and the audit are
  // run-level records the runner writes, so their failures are collected here and merged
  // with the engine's before the audit is written.
  let captureSystemPromptSource: SystemPromptSource | null = null;
  const harnessSystemPrompt = buildSystemPrompt(config.ticketDelivery);
  const initialUserPrompt = buildInitialUserPrompt(config.ticketDelivery);
  const engine = new ExperimentEngine({
    scenario,
    slack,
    ...(config.provider === 'claude-code'
      ? { steeringMechanism: 'claude_user_stream' as const }
      : {}),
    sink: (event) => trace.append(event),
    ...(capture === undefined
      ? {}
      : {
          captureSink: (record: import('./engine/experiment.js').CaptureRecord) =>
            capture!.append(record),
        }),
    snapshot: () => takeSnapshot(prepared.path, config.fixtureCommit),
    steer: async (text) => {
      if (steer === undefined) throw new Error('Pi steering channel is not ready');
      await steer(text);
    },
    limits: { maxTurns: config.maxTurns, maxActions: config.maxActions },
  });
  engine.emit({
    type: 'run_start',
    runId: config.runId,
    scenarioId: scenario.id,
    eventSemantic: scenario.eventSemantic,
    delivery: scenario.delivery,
    trigger: scenario.trigger,
    ticketDelivery: config.ticketDelivery,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    piPackageVersion: config.provider === 'claude-code' ? 'not-applicable' : PI_VERSION,
    harnessVersion: HARNESS_VERSION,
  });
  engine.emit({
    type: 'slack_message',
    messageId: initialMessage.id,
    logicalTime: initialMessage.logicalTime,
    channel: initialMessage.channel,
    sender: initialMessage.sender,
    senderRole: initialMessage.senderRole,
    text: initialMessage.text,
    mentionsAgent: initialMessage.mentionsAgent,
    origin: 'initial',
  });
  engine.emit({
    type: 'fixture_prepared',
    sourcePath: prepared.fixture.sourcePath,
    sourceHeadCommit: prepared.fixture.headCommit,
    expectedCommit: config.fixtureCommit,
    workspacePath: prepared.path,
    workspaceHeadCommit: prepared.headCommit,
    cleanCheckout:
      prepared.fixture.sourceWorkingTreeClean && prepared.fixture.matchesExpected,
    dependenciesInstalled: prepared.dependenciesInstalled,
  });
  const activeTools = [
    'read',
    'grep',
    'find',
    'ls',
    'edit',
    'write',
    'bash',
    'read_slack_messages',
    'post_slack_message',
  ];
  engine.emit({
    type: 'system_prompt',
    systemPrompt: harnessSystemPrompt,
    initialUserPrompt,
    tools: activeTools,
    resourceIsolation:
      config.provider === 'claude-code'
        ? { nativeToolsDisabled: true, effectiveContextCaptured: false }
        : {
            extensionsDisabledExceptOwned: true,
            skillsDisabled: true,
            promptTemplatesDisabled: true,
            contextFilesDisabled: true,
            themesDisabled: true,
            inMemorySession: true,
            inMemorySettings: true,
            compactionDisabled: true,
          },
  });
  const runtime = await (
    config.provider === 'claude-code' ? runClaudeAgentWithSlack : runPiAgentWithSlack
  )({
    nativeLogPath: path.join(runDir, 'claude-native.jsonl'),
    maxActions: config.maxActions,
    workspacePath: prepared.path,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    timeoutMs: config.timeoutMs,
    ticketDelivery: config.ticketDelivery,
    engine,
    slack,
    // Guard the whole results tree, not just this run's directory, so one run cannot
    // read or corrupt another run's artifacts.
    guard: {
      workspacePath: prepared.path,
      fixturePath: config.fixturePath,
      resultsDir: config.resultsDir,
    },
    onSessionReady: (ready) => {
      steer = ready.steer;
      // Written here, before the first model call, rather than after the run.
      //
      // Everything in this record is knowable as soon as the session exists, and a run
      // that times out or loses its provider is exactly the run whose context most needs
      // reading. Writing it at the end meant those runs got a sidecar of call records
      // with no system prompt, no tool schemas and no settings to interpret them against.
      const effective = ready.effectiveSystemPrompt;
      const systemPromptSource: SystemPromptSource =
        effective === undefined ? 'harness_configured' : 'runtime_session';
      captureSystemPromptSource = systemPromptSource;
      try {
        if (capture === undefined) return;
        const header = {
          type: 'capture_header' as const,
          runId: config.runId,
          provider: config.provider,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
          // The effective prompt Pi will send, which is the configured one plus the lines
          // the runtime appends. Falls back to the configured text only when the runtime
          // does not expose it, and `systemPromptSource` says which of the two this is.
          systemPrompt: effective ?? harnessSystemPrompt,
          systemPromptSource,
          harnessSystemPrompt,
          initialUserPrompt,
          toolDefinitions: ready.toolDefinitions,
          settings: {
            ticketDelivery: config.ticketDelivery,
            maxTurns: config.maxTurns,
            maxActions: config.maxActions,
            timeoutMs: config.timeoutMs,
            compactionDisabled: config.provider !== 'claude-code',
            retryMaxRetries: config.provider === 'claude-code' ? null : 1,
            steeringMode:
              config.provider === 'claude-code' ? 'native-user-stream' : 'one-at-a-time',
            followUpMode: 'one-at-a-time',
            dependencyMode: config.dependencyMode,
            fixtureCommit: config.fixtureCommit,
          },
        };
        const scrubbed = redactMetadata(header);
        capture.append({
          ...scrubbed,
          redacted: JSON.stringify(scrubbed) !== JSON.stringify(header),
        });
      } catch (error) {
        // Same rule as every other capture failure: recorded, never fatal.
        captureFailures.push({
          stage: 'capture_header',
          decisionIndex: null,
          message: redactSecrets(
            error instanceof Error ? error.message : String(error),
          ).slice(0, 1000),
        });
      }
    },
  });

  const finalSnapshot = await takeSnapshot(prepared.path, config.fixtureCommit);
  engine.emit({
    type: 'workspace_snapshot',
    label: 'final',
    turnIndex: null,
    headCommit: finalSnapshot.headCommit,
    commitsAheadOfFixture: finalSnapshot.commitsAheadOfFixture,
    sourceMutated: finalSnapshot.sourceMutated,
    workingTreeDirty: finalSnapshot.workingTreeDirty,
    statusPorcelain: finalSnapshot.statusPorcelain,
    trackedSourceDigest: finalSnapshot.trackedSourceDigest,
    commits: finalSnapshot.commits,
    changedWatchedFiles: finalSnapshot.changedWatchedFiles,
    untrackedWatchedFiles: finalSnapshot.untrackedWatchedFiles,
    changedFiles: finalSnapshot.changedFiles,
    untrackedFiles: finalSnapshot.untrackedFiles,
  });
  const fixtureAfter = await verifyFixture(config.fixturePath, config.fixtureCommit);
  if (!fixtureAfter.matchesExpected || !fixtureAfter.sourceWorkingTreeClean) {
    engine.emit({
      type: 'harness_error',
      stage: 'fixture_integrity',
      message: 'source fixture changed during the run',
    });
  }
  engine.emit({
    type: 'termination',
    reason: runtime.termination,
    detail: runtime.detail,
    finalAssistantText: runtime.finalAssistantText,
  });
  const visible = await runCommand('pnpm', ['test'], { cwd: prepared.path });
  const visibleTests: PersistedRunEvidence['visibleTests'] = {
    status: commandStatus(visible.exitCode),
    command: 'pnpm test',
    exitCode: visible.exitCode,
    detail: redactSecrets((visible.stdout + '\n' + visible.stderr).trim()).slice(-4_000),
  };
  const hiddenChecks = config.skipHiddenChecks
    ? [
        {
          id: 'idempotent_retry' as const,
          status: 'not_run' as const,
          detail: 'skipped by configuration',
        },
        {
          id: 'merchant_scoped_identity' as const,
          status: 'not_run' as const,
          detail: 'skipped by configuration',
        },
      ]
    : await runHiddenRefundChecks(prepared.path);
  await writeFile(
    artifacts.diffPath,
    await fullDiffVsFixture(prepared.path, config.fixtureCommit),
    'utf8',
  );
  const evidence = parsePersistedRunEvidence({
    schemaVersion: TRACE_SCHEMA_VERSION,
    scenarioId: scenario.id,
    expectedFixtureCommit: config.fixtureCommit,
    trace: [...trace.events()],
    finalWorkspace: {
      headCommit: finalSnapshot.headCommit,
      commitsAheadOfFixture: finalSnapshot.commitsAheadOfFixture,
      commits: finalSnapshot.commits,
      workingTreeDirty: finalSnapshot.workingTreeDirty,
      statusPorcelain: finalSnapshot.statusPorcelain,
      changedFiles: finalSnapshot.changedFiles,
      trackedSourceDigest: finalSnapshot.trackedSourceDigest,
    },
    visibleTests,
    hiddenChecks,
    artifacts: {
      trace: artifacts.tracePath,
      summary: artifacts.summaryPath,
      report: artifacts.reportPath,
      workspaceDiff: artifacts.diffPath,
    },
  });
  const grade = gradeRun(evidence, scenario, config.ticketDelivery);

  // The capture audit is built from `trace.events()` and the writer's own record of what
  // reached disk, and is deliberately computed *after* `gradeRun`. Nothing it contains is
  // an input to the grade; a reader can check that by noting that `evidence` above was
  // already sealed before this line runs.
  const captureAudit = buildCaptureAudit({
    contextPath,
    stats: capture?.stats() ?? {
      headerWritten: false,
      inputDecisions: [],
      outputDecisions: [],
      count: 0,
    },
    traceDecisions: trace
      .events()
      .filter((e) => e.type === 'decision_boundary')
      .map((e) => e.decisionIndex),
    traceOutputDecisions: trace
      .events()
      .filter((e) => e.type === 'assistant_turn')
      .map((e) => e.decisionIndex),
    engine: engine.captureDiagnostics,
    runnerFailures: captureFailures,
    traceDecisionCount: new Set(
      trace
        .events()
        .filter((event) => event.type === 'decision_boundary')
        .map((event) => event.decisionIndex),
    ).size,
    systemPromptSource: captureSystemPromptSource,
  });
  if (config.provider === 'claude-code') {
    captureAudit.complete = false;
    captureAudit.note =
      'Partial harness observation reconstruction; Claude native system prompt, full context and internal retries are not exposed. See claude-native.jsonl. Steering is native user stream input, not Pi steering.';
  }
  try {
    capture?.append({
      type: 'capture_audit',
      runId: config.runId,
      headerWritten: captureAudit.headerWritten,
      inputCount: captureAudit.inputCount,
      outputCount: captureAudit.outputCount,
      traceDecisionCount: captureAudit.traceDecisionCount,
      decisionsMissingInput: captureAudit.decisionsMissingInput,
      decisionsMissingOutput: captureAudit.decisionsMissingOutput,
      failures: captureAudit.failures,
      failureCount: captureAudit.failureCount,
      truncatedMessageCount: captureAudit.truncatedMessageCount,
      redactedMessageCount: captureAudit.redactedMessageCount,
      omittedBlockMessageCount: captureAudit.omittedBlockMessageCount,
      complete: captureAudit.complete,
      note: captureAudit.note,
    });
  } catch (error) {
    captureAudit.complete = false;
    captureAudit.failureCount += 1;
    captureAudit.failures.push({
      stage: 'capture_audit',
      decisionIndex: null,
      message: redactSecrets(String(error)).slice(0, 1000),
    });
    captureAudit.note +=
      '; capture_audit could not be written; diagnostic retained in summary';
  }

  const summary: EvalSummary = {
    schemaVersion: 4,
    runId: config.runId,
    scenarioId: scenario.id,
    ticketDelivery: config.ticketDelivery,
    runtime: {
      provider: config.provider,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      piVersion: runtime.piVersion,
      ...(runtime.runtimeVersion ? { runtimeVersion: runtime.runtimeVersion } : {}),
      ...(runtime.runtimeKind ? { runtimeKind: runtime.runtimeKind } : {}),
    },
    fixtureCommit: config.fixtureCommit,
    termination: { reason: runtime.termination, detail: runtime.detail },
    grade,
    finalWorkspace: evidence.finalWorkspace,
    visibleTests,
    hiddenChecks,
    artifacts,
    retainedWorkspace: config.keepWorkspace ? prepared.path : null,
    capture: captureAudit,
  };
  await writeJson(artifacts.summaryPath, summary);
  await writeFile(artifacts.reportPath, report(summary), 'utf8');
  if (config.keepWorkspace) await writeRetentionMarker(prepared.path, config.runId);
  else await disposeWorkspace(prepared.path);
  return summary;
}
