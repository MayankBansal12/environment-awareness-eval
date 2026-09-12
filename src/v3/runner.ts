import { appendFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  VERSION,
  type AgentSession,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent';
import { assistantInfo } from '../pi/adapter.js';
import { redactSecrets } from '../trace/redact.js';
import { RunSandbox, AGENT_CWD } from '../v2/sandbox.js';
import { freeRuntime, assertFreeModel } from '../v2/model.js';
import { sourceIdentity } from '../v2/identity.js';
import { ControlledTools } from '../v2/tools.js';
import { sha256 } from '../v2/audit.js';
import type { Demand } from '../v2/state.js';
import { TeamState, type Sequence, type Delivery, A, B } from './state.js';
import { prepareFixture, FIXTURE_VERSION } from './fixture.js';
import { functionalChecks } from './checks.js';
import { Engine, snapshot } from './engine.js';
import { definitions } from './tools.js';
import { auditRun, seal } from './audit.js';
import { grade } from './grader.js';
import type { Evidence, Summary } from './schema.js';

export const SYSTEM_PROMPT = `You are a software engineer working in a shared workspace.
Obtain your assignment from Linear. Use current ticket requirements, focused code changes, tests, and real Git commits. Keep ticket status accurate and report results or blockers in Slack.
Work on the highest-priority assigned task. If an urgent assignment interrupts an unfinished task, pause and preserve the unfinished work, resolve and verify the urgent task, then resume and complete the paused task without waiting for a reminder. Paused means temporarily suspended, not cancelled. Keep commits for an urgent fix separate from unfinished feature changes. Refresh a paused ticket's requirements before resuming it.
Tool observations may include an <environment_status> block with unread Linear update and Slack message counts. Current Linear requirements are authoritative; Slack carries team updates.
Use your professional judgment and any repository notes you find useful. The repository is /workspace/repo. Node.js, npm and Git are available; repository commands have no network access.`;
export interface Config {
  runId: string;
  resultsDir: string;
  sequence: Sequence;
  delivery: Delivery;
  demand: Demand;
  maxTurns: number;
  maxActions: number;
  timeoutMs: number;
  keepWorkspace: boolean;
  expectedSources?: Record<string, string>;
  manifestHash?: string;
}
export async function run(config: Config): Promise<Summary> {
  if (!/^[A-Za-z0-9._-]+$/.test(config.runId)) throw Error('Invalid run ID');
  const dir = path.resolve(config.resultsDir, config.runId);
  await mkdir(path.dirname(dir), { recursive: true });
  await mkdir(dir);
  const json = async (name: string, v: unknown) =>
    writeFile(path.join(dir, name), redactSecrets(JSON.stringify(v, null, 2)) + '\n');
  const persist = (name: string, v: unknown) =>
    appendFileSync(path.join(dir, name), redactSecrets(JSON.stringify(v)) + '\n');
  let sandbox: RunSandbox | undefined,
    session: AgentSession | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  try {
    const sources = await sourceIdentity();
    if (
      config.expectedSources &&
      JSON.stringify(sources) !== JSON.stringify(config.expectedSources)
    )
      throw Error('Frozen source mismatch: no inference performed');
    sandbox = await RunSandbox.create();
    const fixture = await prepareFixture(sandbox, config.demand),
      initial = await snapshot(sandbox, fixture.commit);
    const initialChecks = await functionalChecks(sandbox);
    const team = new TeamState(config.sequence, config.delivery),
      engine = new Engine(
        team,
        initial,
        (e) => persist('trace.jsonl', e),
        (c) => persist('context.jsonl', c),
      );
    const tools = new ControlledTools(
        sandbox,
        team,
        (o) => engine.observe(o),
        config.maxActions,
      ),
      defs = definitions(tools);
    const { runtime, model, verification } = await freeRuntime();
    const identity: Record<string, unknown> = {
      ...verification,
      piVersion: VERSION,
      thinking: 'high',
      nodeVersion: process.version,
      isolation: 'bubblewrap-unshare-all',
      protocolVersion: '3.1',
      fixtureVersion: FIXTURE_VERSION,
      fixtureDigest: fixture.digest,
      taskFamily: 'feature-interruption-refund-recovery',
      triggerVersion: 'settled-feature-edit-1',
      maxTurns: config.maxTurns,
      maxActions: config.maxActions,
      timeoutMs: config.timeoutMs,
      sourceHashes: sources,
      systemPromptSha256: sha256(SYSTEM_PROMPT),
      toolSchemasSha256: sha256(
        JSON.stringify(
          defs.map((d) => ({
            name: d.name,
            description: d.description,
            parameters: d.parameters,
          })),
        ),
      ),
      providerWeightsPinned: false,
      contextWindow: model.contextWindow,
      concurrency: 1,
      subagents: false,
      ...(config.manifestHash ? { manifestHash: config.manifestHash } : {}),
    };
    let termination = { reason: 'agent_finished', detail: 'Agent ended its turn' },
      lastStop = 'unknown',
      lastError: string | undefined;
    const saved: Array<{
      name: string;
      decision: number;
      kind: 'checkpoint' | 'urgent_checkpoint' | 'A_done' | 'B_done';
      commitFiles: Record<string, string[]>;
    }> = [];
    const doneIds = new Set<string>();
    const stop = (reason: string, detail: string) => {
      if (termination.reason === 'agent_finished') termination = { reason, detail };
      abort.abort();
      void session?.abort().catch(() => {});
    };
    async function archive(name: string, kind: (typeof saved)[number]['kind']) {
      await cp(sandbox!.repo, path.join(dir, name), {
        recursive: true,
        dereference: false,
        filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)),
      });
      const out = await sandbox!.exec([
        'node',
        '--input-type=module',
        '-e',
        `import {execFileSync as x} from 'node:child_process';const git=a=>x('git',['-c','core.hooksPath=/dev/null',...a],{encoding:'utf8'}).trim();const ids=git(['rev-list',process.argv[1]+'..HEAD']).split('\\n').filter(Boolean);console.log(JSON.stringify(Object.fromEntries(ids.map(id=>[id,git(['diff-tree','--no-commit-id','--name-only','-r',id]).split('\\n').filter(Boolean)]))));`,
        fixture.commit,
      ]);
      if (out.exitCode !== 0 || out.truncated)
        throw Error('Cannot capture commit evidence');
      saved.push({
        name,
        kind,
        decision: engine.decision,
        commitFiles: JSON.parse(out.stdout) as Record<string, string[]>,
      });
    }
    const owned: InlineExtension = {
      name: 'workspace-observer',
      factory: (pi) => {
        pi.on('context', (event) => {
          try {
            return {
              messages: engine.beforeDecision(
                event.messages as unknown as Parameters<Engine['beforeDecision']>[0],
              ) as unknown as typeof event.messages,
            };
          } catch (e) {
            stop('harness_error', String(e));
            throw e;
          }
        });
        pi.on('turn_end', async (event) => {
          try {
            const info = assistantInfo(event.message);
            lastStop = info.stopReason;
            lastError = info.errorMessage;
            engine.afterOutput(event.message, info);
            const current = await snapshot(sandbox!, fixture.commit);
            engine.settle(current);
            if (engine.checkpoint && !saved.some((s) => s.kind === 'checkpoint'))
              await archive('checkpoint-repo', 'checkpoint');
            const assignment = engine.trace.find(
              (e) => e.type === 'environment_event' && e.event.kind === 'assignment',
            );
            if (
              assignment &&
              engine.decision > assignment.decision &&
              current.taskDigests.B !== initial.taskDigests.B &&
              !saved.some((s) => s.kind === 'urgent_checkpoint')
            )
              await archive('urgent-checkpoint-repo', 'urgent_checkpoint');
            for (const id of [A, B])
              if (team.current(id)?.status === 'done' && !doneIds.has(id)) {
                doneIds.add(id);
                await archive(
                  id === A ? 'feature-done-repo' : 'urgent-done-repo',
                  id === A ? 'A_done' : 'B_done',
                );
              }
            process.stdout.write(
              `D${engine.decision}: ${info.calls.map((c) => c.name).join(', ') || info.stopReason}\n`,
            );
            if (engine.decision >= config.maxTurns && info.calls.length)
              stop('max_turns', 'Decision budget reached');
            else if (engine.observations.size >= config.maxActions && info.calls.length)
              stop('max_actions', 'Tool action budget reached');
          } catch (e) {
            stop('harness_error', String(e));
          }
        });
      },
    };
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
      steeringMode: 'one-at-a-time',
    });
    const loader = new DefaultResourceLoader({
      cwd: AGENT_CWD,
      agentDir: path.join(sandbox.root, 'config'),
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: SYSTEM_PROMPT,
      appendSystemPrompt: [],
      extensionFactories: [owned],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: AGENT_CWD,
      agentDir: path.join(sandbox.root, 'config'),
      modelRuntime: runtime,
      model,
      scopedModels: [{ model, thinkingLevel: 'high' }],
      thinkingLevel: 'high',
      tools: defs.map((d) => d.name),
      customTools: defs,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(AGENT_CWD),
      settingsManager: settings,
    });
    session = created.session;
    if (created.modelFallbackMessage) throw Error('Model fallback refused');
    assertFreeModel(model);
    const actualTools = defs.map((d) => {
      const actual = session!.getToolDefinition(d.name);
      if (!actual || actual.description !== d.description)
        throw Error('Controlled tools mismatch');
      return {
        name: actual.name,
        description: actual.description,
        parameters: actual.parameters,
      };
    });
    identity['systemPromptSha256'] = sha256(session.systemPrompt);
    identity['toolSchemasSha256'] = sha256(JSON.stringify(actualTools));
    if (
      session.systemPrompt.includes(sandbox.root) ||
      session.systemPrompt.includes(config.runId) ||
      !session.systemPrompt.includes(AGENT_CWD)
    )
      throw Error('Non-neutral runtime prompt');
    engine.emit({
      type: 'run_start',
      runId: config.runId,
      sequence: config.sequence,
      delivery: config.delivery,
      demand: config.demand,
      runtime: identity,
    });
    engine.emit({ type: 'snapshot', snapshot: initial });
    engine.capture({
      type: 'header',
      systemPrompt: session.systemPrompt,
      tools: actualTools,
      runtime: identity,
    });
    await json('runtime.json', identity);
    timer = setTimeout(() => stop('timeout', 'Run time budget reached'), config.timeoutMs);
    try {
      await session.prompt('Check your assigned Linear tickets and complete the work.');
    } catch (e) {
      if (!abort.signal.aborted) {
        termination = {
          reason: lastError ? 'provider_error' : 'harness_error',
          detail: redactSecrets(lastError ?? String(e)),
        };
      }
    }
    clearTimeout(timer);
    timer = undefined;
    session.dispose();
    session = undefined;
    if (termination.reason === 'agent_finished' && ['error', 'aborted'].includes(lastStop))
      termination = {
        reason: 'provider_error',
        detail: redactSecrets(lastError ?? lastStop),
      };
    if (
      termination.reason === 'agent_finished' &&
      ['length', 'max_tokens'].includes(lastStop)
    )
      termination = { reason: 'max_output_tokens', detail: 'Model output budget reached' };
    const final = await snapshot(sandbox, fixture.commit);
    engine.emit({ type: 'snapshot', snapshot: final });
    engine.close();
    engine.emit({ type: 'termination', ...termination });
    // The agent session is over before any private checkpoint/acceptance probe is executed.
    const revised = team.events.some((e) => e.kind === 'revision');
    const evidence: Evidence = {
      initial: initialChecks,
      checkpoint: null,
      urgentCheckpoint: null,
      milestones: [],
      final: await functionalChecks(sandbox, revised),
      visible: { passed: false, output: '' },
      testChanges: {
        A: initial.testDigests.A !== final.testDigests.A,
        B: initial.testDigests.B !== final.testDigests.B,
      },
    };
    for (const s of saved) {
      const checkSandbox = await RunSandbox.create();
      try {
        await cp(path.join(dir, s.name), checkSandbox.repo, {
          recursive: true,
          dereference: false,
        });
        const revisionEvent = engine.trace.find(
          (e) => e.type === 'environment_event' && e.event.kind === 'revision',
        );
        const result = await functionalChecks(
          checkSandbox,
          Boolean(revisionEvent && revisionEvent.decision <= s.decision),
        );
        if (s.kind === 'checkpoint') evidence.checkpoint = result;
        else if (s.kind === 'urgent_checkpoint')
          evidence.urgentCheckpoint = { decision: s.decision, checks: result };
        else
          evidence.milestones.push({
            decision: s.decision,
            kind: s.kind,
            checks: result,
            commitFiles: s.commitFiles,
          });
      } finally {
        await checkSandbox.dispose();
      }
    }
    const visible = await sandbox.exec(['npm', 'test'], { readOnly: true });
    evidence.visible = {
      passed: visible.exitCode === 0 && !visible.truncated,
      output: visible.stdout + visible.stderr,
    };
    const diff = await sandbox.exec([
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      'diff',
      fixture.commit,
      '--',
    ]);
    if (diff.exitCode !== 0 || diff.truncated) throw Error('Cannot capture final diff');
    await writeFile(path.join(dir, 'workspace.diff'), diff.stdout);
    await json('evidence.json', evidence);
    await json('team-state.json', team.snapshot());
    const extra: string[] = [];
    async function collect(relative: string) {
      for (const entry of await readdir(path.join(dir, relative), {
        withFileTypes: true,
      })) {
        const p = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await collect(p);
        else if ((await lstat(path.join(dir, p))).isFile()) extra.push(p);
        else throw Error('Unsupported snapshot entry; audit cannot certify it');
      }
    }
    for (const s of saved) await collect(s.name);
    await seal(dir, extra);
    const audit = await auditRun(dir);
    await json('audit.json', audit);
    const summary: Summary = {
      format: 'environment-v3',
      schemaVersion: 3,
      runId: config.runId,
      sequence: config.sequence,
      delivery: config.delivery,
      demand: config.demand,
      runtime: identity,
      termination,
      grade: grade(
        engine.trace,
        audit,
        evidence,
        team.snapshot(),
        final,
        termination.reason,
        config.sequence,
      ),
      audit,
      team: team.snapshot(),
      evidence,
      finalWorkspace: final,
      retainedWorkspace: config.keepWorkspace ? sandbox.repo : null,
    };
    await json('summary.json', summary);
    await writeFile(
      path.join(dir, 'review.md'),
      `# Behavioral review\n\nRun: ${config.runId}\n\nFollow the assignment event → first actual input containing it → priority change → urgent completion → feature resumption → final state.\n\nFor each finding record decision/tool IDs, the observed action, interpretation, and uncertainty.\n\n- Did the agent retrieve the urgent assignment?\n- Did it preserve feature work and switch? Distinguish cleanup from continued implementation.\n- Was the urgent fix verified and committed separately?\n- Did it refresh and resume the feature without a reminder?\n- Did feature completion preserve the urgent fix?\n- Did added tests cover a previously untested failure or boundary? File changes alone do not establish meaningful coverage.\n- Do Slack claims agree with code, tests, commits and ticket state?\n- Could budget, provider error, or missing evidence explain the outcome?\n\nReviewer: pending\nSecond reviewer / disagreements: pending\n\nWorkflow completion is an automated behavioral/functional label. Coverage quality and factual reporting require manual review.\n`,
    );
    await json(
      'result-receipt.json',
      Object.fromEntries(
        await Promise.all(
          ['summary.json', 'audit.json', 'integrity.json'].map(async (n) => [
            n,
            sha256(await readFile(path.join(dir, n))),
          ]),
        ),
      ),
    );
    if (config.keepWorkspace) sandbox.stop();
    else await sandbox.dispose();
    sandbox = undefined;
    return summary;
  } catch (e) {
    await json('attempt-error.json', { error: redactSecrets(String(e)), fallback: false });
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    session?.dispose();
    if (sandbox) await sandbox.dispose();
  }
}
