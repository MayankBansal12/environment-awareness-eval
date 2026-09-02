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
import { runPiAgentWithSlack } from './pi/adapter.js';
import { CONTROLLED_SYSTEM_PROMPT, INITIAL_USER_PROMPT } from './prompt/system-prompt.js';
import { getScenario, isScenarioSupported } from './scenarios/catalog.js';
import { TICKET_MESSAGE } from './scenarios/messages.js';
import { TRACE_SCHEMA_VERSION } from './trace/schema.js';
import { TraceWriter, redactSecrets, writeJson } from './trace/writer.js';
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
  summaryPath: string;
  reportPath: string;
  diffPath: string;
}
export interface EvalSummary {
  schemaVersion: 2;
  runId: string;
  scenarioId: string;
  runtime: { provider: string; model: string; thinkingLevel: string; piVersion: string };
  fixtureCommit: string;
  termination: { reason: string; detail: string };
  grade: GradeResult;
  finalWorkspace: PersistedRunEvidence['finalWorkspace'];
  visibleTests: PersistedRunEvidence['visibleTests'];
  hiddenChecks: PersistedRunEvidence['hiddenChecks'];
  artifacts: RunArtifacts;
  retainedWorkspace: string | null;
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

This is a model + Pi + prompt + tools trajectory, not a claim about internal cognition.
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
export async function runEvaluation(config: RunConfig): Promise<EvalSummary> {
  const scenario = getScenario(config.scenarioId);
  if (!isScenarioSupported(scenario))
    throw new Error(scenario.unsupportedReason ?? 'scenario is unsupported');
  assertControlled(config);
  const runDir = path.join(config.resultsDir, config.runId);
  await mkdir(runDir, { recursive: true });
  const trace = await TraceWriter.create(runDir);
  const artifacts: RunArtifacts = {
    runDir,
    tracePath: trace.path,
    summaryPath: path.join(runDir, 'summary.json'),
    reportPath: path.join(runDir, 'report.md'),
    diffPath: path.join(runDir, 'workspace.diff'),
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
  let steer: ((text: string) => Promise<void>) | undefined;
  const engine = new ExperimentEngine({
    scenario,
    slack,
    sink: (event) => trace.append(event),
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
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    piPackageVersion: PI_VERSION,
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
    systemPrompt: CONTROLLED_SYSTEM_PROMPT,
    initialUserPrompt: INITIAL_USER_PROMPT,
    tools: activeTools,
    resourceIsolation: {
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
  const runtime = await runPiAgentWithSlack({
    workspacePath: prepared.path,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    timeoutMs: config.timeoutMs,
    engine,
    slack,
    // Guard the whole results tree, not just this run's directory, so one run cannot
    // read or corrupt another run's artifacts.
    guard: {
      workspacePath: prepared.path,
      fixturePath: config.fixturePath,
      resultsDir: config.resultsDir,
    },
    onSessionReady: (send) => {
      steer = send;
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
  const grade = gradeRun(evidence, scenario);
  const summary: EvalSummary = {
    schemaVersion: 2,
    runId: config.runId,
    scenarioId: scenario.id,
    runtime: {
      provider: config.provider,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      piVersion: runtime.piVersion,
    },
    fixtureCommit: config.fixtureCommit,
    termination: { reason: runtime.termination, detail: runtime.detail },
    grade,
    finalWorkspace: evidence.finalWorkspace,
    visibleTests,
    hiddenChecks,
    artifacts,
    retainedWorkspace: config.keepWorkspace ? prepared.path : null,
  };
  await writeJson(artifacts.summaryPath, summary);
  await writeFile(artifacts.reportPath, report(summary), 'utf8');
  if (config.keepWorkspace) await writeRetentionMarker(prepared.path, config.runId);
  else await disposeWorkspace(prepared.path);
  return summary;
}
