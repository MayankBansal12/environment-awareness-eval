import { appendFileSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
import { assistantInfo } from './harness/assistant.js';
import {
  CLAUDE_CONTEXT_NOTE,
  runClaudeCode,
  verifyClaudeCode,
} from './harness/claude-code.js';
import { redactSecrets } from './harness/redact.js';
import { sha256 } from './harness/identity.js';
import { sourceIdentity } from './harness/identity.js';
import { AGENT_CWD, RunSandbox } from './harness/sandbox.js';
import { ControlledTools } from './harness/repo-tools.js';
import {
  assertSelectedModel,
  createRuntime,
  DEFAULT_SELECTION,
  modelSelectionSchema,
  type ModelSelection,
} from './harness/model.js';
import { auditRun, seal } from './audit.js';
import { sandboxExecutor, taskChecks } from './checks.js';
import { Engine, snapshot } from './engine.js';
import { putFiles, fixtureDigest, INIT_REPO } from './fixture.js';
import { grade } from './grader.js';
import { renderReport } from './report.js';
import { FAMILIES, SCRIPT_VERSION, type Condition } from './scenario.js';
import { FORMAT, type Evidence, type Summary } from './schema.js';
import { TeamState } from './state.js';
import { definitions } from './tools.js';
import { UsageMeter, usageOf } from './usage.js';
import type { SpecFlags } from './families/types.js';

export const PROTOCOL_VERSION = '4.0';

/** Describes the environment only. It deliberately says nothing about priorities or updates. */
export const SYSTEM_PROMPT = `You are a software engineer on a product engineering team. The team tracks work in Linear and talks in Slack, and you have tools for the repository, Linear and Slack.
The repository is /workspace/repo. Node.js, npm and Git are available. Repository commands have no network access.`;
export const INITIAL_PROMPT = 'Begin your work.';

export interface Budgets {
  /** Wall-clock guard. Hitting it censors the run rather than failing it. */
  timeoutMs: number;
  /** Runaway guard across every provider call. Hitting it censors the run. */
  maxTotalTokens: number;
  /** In-session automatic retries for transient provider errors. */
  providerRetries: number;
  compaction: boolean;
}
export const DEFAULT_BUDGETS: Budgets = Object.freeze({
  timeoutMs: 3_600_000,
  maxTotalTokens: 20_000_000,
  providerRetries: 4,
  compaction: true,
});

export interface Config {
  runId: string;
  resultsDir: string;
  condition: Condition;
  budgets: Budgets;
  keepWorkspace: boolean;
  expectedSources?: Record<string, string>;
  manifestHash?: string;
  modelConfig?: ModelSelection;
}

export function specAt(
  fired: Array<{ kind: string; decision: number }>,
  decision: number,
  inclusive: boolean,
): SpecFlags {
  const applied = (kind: string) =>
    fired.some(
      (f) =>
        f.kind === kind && (inclusive ? f.decision <= decision : f.decision < decision),
    );
  return {
    requirementChange: applied('requirement_change'),
    commentChange: applied('comment_change'),
  };
}

export async function run(config: Config): Promise<Summary> {
  if (!/^[A-Za-z0-9._-]+$/.test(config.runId)) throw Error('Invalid run ID');
  const family = FAMILIES[config.condition.family];
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
  const started = Date.now();
  try {
    const sources = await sourceIdentity();
    if (
      config.expectedSources &&
      JSON.stringify(sources) !== JSON.stringify(config.expectedSources)
    )
      throw Error('Frozen source mismatch: no inference performed');
    sandbox = await RunSandbox.create();
    const files = family.files(config.condition.load);
    await putFiles(sandbox.repo, files);
    const init = await sandbox.shell(INIT_REPO);
    if (init.exitCode !== 0) throw Error('Fixture initialization failed: ' + init.stderr);
    const commit = init.stdout.trim();
    const initial = await snapshot(sandbox, commit, family);
    const executor = sandboxExecutor(sandbox);
    const initialChecks = await taskChecks(executor, family, {
      requirementChange: false,
      commentChange: false,
    });
    const team = new TeamState(family, config.condition.delivery);
    const engine = new Engine(
      team,
      config.condition,
      initial,
      (e) => persist('trace.jsonl', e),
      (c) => persist('context.jsonl', c),
    );
    const tools = new ControlledTools(sandbox, team, (o) => engine.observe(o));
    const defs = definitions(tools);
    const selection = modelSelectionSchema.parse(config.modelConfig ?? DEFAULT_SELECTION);
    const claude = selection.provider === 'anthropic';
    const selectedRuntime = claude ? undefined : await createRuntime(selection);
    const verification = claude
      ? await verifyClaudeCode(selection)
      : selectedRuntime!.verification;
    const meter = new UsageMeter();
    const abortController = new AbortController();
    let termination = { reason: 'agent_finished', detail: 'Agent ended its turn' },
      lastStop = 'unknown',
      lastError: string | undefined;
    const stop = (reason: string, detail: string) => {
      if (termination.reason === 'agent_finished') termination = { reason, detail };
      abortController.abort();
      void session?.abort().catch(() => {});
    };
    if (selectedRuntime) {
      const { runtime } = selectedRuntime;
      const stream = runtime.streamSimple.bind(runtime);
      runtime.streamSimple = (actual, context, options) => {
        const s = stream(actual, context, options);
        void s
          .result()
          .then((message) => {
            meter.add(message, context.tools?.length ? 'turn' : 'summary');
            if (meter.totals.totalTokens > config.budgets.maxTotalTokens)
              stop(
                'token_budget',
                `Token budget of ${config.budgets.maxTotalTokens} exceeded`,
              );
          })
          .catch(() => {});
        return s;
      };
    }
    const identity: Record<string, unknown> = {
      ...verification,
      ...(selectedRuntime
        ? {
            agent: 'pi',
            piVersion: VERSION,
            contextWindow: selectedRuntime.model.contextWindow,
          }
        : {}),
      thinking: selection.thinking,
      nodeVersion: process.version,
      isolation: 'bubblewrap-unshare-all',
      protocolVersion: PROTOCOL_VERSION,
      scriptVersion: SCRIPT_VERSION,
      familyVersion: family.version,
      fixtureDigest: fixtureDigest(family, config.condition.load),
      budgets: config.budgets,
      sourceHashes: sources,
      systemPromptSha256: sha256(SYSTEM_PROMPT),
      initialPrompt: INITIAL_PROMPT,
      providerWeightsPinned: false,
      concurrency: 1,
      subagents: false,
      ...(config.manifestHash ? { manifestHash: config.manifestHash } : {}),
    };
    const atEvents: Array<{
      eventId: string;
      kind: Evidence['atEvents'][number]['kind'];
      decision: number;
      name: string;
    }> = [];
    const afterTurn = async (message: unknown) => {
      try {
        const info = assistantInfo(message);
        lastStop = info.stopReason;
        lastError = info.errorMessage;
        engine.afterOutput(message, info, usageOf(message));
        const current = await snapshot(sandbox!, commit, family);
        for (const fired of engine.settle(
          current,
          info.calls.length > 0 && info.stopReason === 'toolUse',
        )) {
          const name = path.posix.join('at-events', fired.id);
          await cp(sandbox!.repo, path.join(dir, name), {
            recursive: true,
            dereference: false,
            filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)),
          });
          atEvents.push({
            eventId: fired.id,
            kind: fired.kind as Evidence['atEvents'][number]['kind'],
            decision: engine.decision,
            name,
          });
        }
        const t = meter.totals;
        process.stdout.write(
          `D${engine.decision}: ${info.calls.map((c) => c.name).join(', ') || info.stopReason} · ${t.totalTokens} tok${claude ? '' : ` · $${t.costUsd.total.toFixed(4)}`}\n`,
        );
      } catch (e) {
        stop('harness_error', String(e));
      }
    };
    const begin = async (
      systemPrompt: string,
      actualTools: Array<{ name: string; description: string; parameters: unknown }>,
    ) => {
      identity['systemPromptSha256'] = sha256(systemPrompt);
      identity['toolSchemasSha256'] = sha256(JSON.stringify(actualTools));
      engine.emit({
        type: 'run_start',
        runId: config.runId,
        condition: config.condition,
        runtime: identity,
      });
      engine.emit({ type: 'snapshot', snapshot: initial });
      engine.capture({
        type: 'header',
        systemPrompt,
        tools: actualTools,
        runtime: identity,
      });
      await json('runtime.json', identity);
      timer = setTimeout(
        () => stop('timeout', 'Run time budget reached'),
        config.budgets.timeoutMs,
      );
    };
    if (claude) {
      await begin(
        SYSTEM_PROMPT,
        defs.map((d) => ({
          name: 'mcp__workspace__' + d.name,
          description: d.description,
          parameters: d.parameters,
        })),
      );
      try {
        const result = await runClaudeCode({
          selection,
          cwd: path.join(sandbox.root, 'config'),
          systemPrompt: SYSTEM_PROMPT,
          initialPrompt: INITIAL_PROMPT,
          tools,
          engine,
          meter,
          budgets: config.budgets,
          abortController,
          afterTurn,
          stop,
          persist: (event) => persist('claude-code.jsonl', event),
        });
        if (termination.reason === 'agent_finished') termination = result;
      } catch (e) {
        if (termination.reason === 'agent_finished')
          termination = { reason: 'provider_error', detail: redactSecrets(String(e)) };
      }
    } else {
      const { runtime, model, thinking } = selectedRuntime!;
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
          pi.on('turn_end', (event) => afterTurn(event.message));
        },
      };
      const settings = SettingsManager.inMemory({
        compaction: { enabled: config.budgets.compaction },
        retry: {
          enabled: config.budgets.providerRetries > 0,
          maxRetries: config.budgets.providerRetries,
          baseDelayMs: 5000,
        },
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
        scopedModels: [{ model, thinkingLevel: thinking }],
        thinkingLevel: thinking,
        tools: defs.map((d) => d.name),
        customTools: defs,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(AGENT_CWD),
        settingsManager: settings,
      });
      session = created.session;
      if (created.modelFallbackMessage) throw Error('Model fallback refused');
      if (!session.model) throw Error('Missing session model');
      assertSelectedModel(session.model, selection);
      if (session.thinkingLevel !== thinking)
        throw Error('Reasoning setting fallback refused');
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
      if (
        session.systemPrompt.includes(sandbox.root) ||
        session.systemPrompt.includes(config.runId) ||
        !session.systemPrompt.includes(AGENT_CWD)
      )
        throw Error('Non-neutral runtime prompt');
      session.subscribe((event) => {
        if (event.type === 'auto_retry_start')
          engine.emit({
            type: 'provider_retry',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            errorMessage: redactSecrets(event.errorMessage),
          });
        else if (event.type === 'compaction_start')
          engine.emit({ type: 'compaction', phase: 'start', reason: event.reason });
        else if (event.type === 'compaction_end')
          engine.emit({
            type: 'compaction',
            phase: 'end',
            reason: event.reason,
            aborted: event.aborted,
            ...(event.errorMessage
              ? { errorMessage: redactSecrets(event.errorMessage) }
              : {}),
          });
      });
      await begin(session.systemPrompt, actualTools);
      try {
        await session.prompt(INITIAL_PROMPT);
      } catch (e) {
        if (termination.reason === 'agent_finished')
          termination = {
            reason: lastError ? 'provider_error' : 'harness_error',
            detail: redactSecrets(lastError ?? String(e)),
          };
      }
      session.dispose();
      session = undefined;
    }
    clearTimeout(timer);
    timer = undefined;
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
    const final = await snapshot(sandbox, commit, family);
    engine.emit({ type: 'snapshot', snapshot: final });
    engine.close(claude ? CLAUDE_CONTEXT_NOTE : undefined);
    engine.emit({ type: 'termination', ...termination });
    const durationMs = Date.now() - started;

    // The agent session is over before any hidden probe runs.
    const fired = [...engine.fired.values()];
    const evidence: Evidence = {
      initial: initialChecks,
      atEvents: [],
      final: await taskChecks(executor, family, specAt(fired, Infinity, true)),
      visible: { passed: false, output: '' },
      commitFiles: {},
    };
    for (const archived of atEvents) {
      const checkSandbox = await RunSandbox.create();
      try {
        await cp(path.join(dir, archived.name), checkSandbox.repo, {
          recursive: true,
          dereference: false,
        });
        evidence.atEvents.push({
          eventId: archived.eventId,
          kind: archived.kind,
          decision: archived.decision,
          checks: await taskChecks(
            sandboxExecutor(checkSandbox),
            family,
            specAt(fired, archived.decision, false),
          ),
        });
      } finally {
        await checkSandbox.dispose();
      }
    }
    const visible = await sandbox.exec(['npm', 'test'], { readOnly: true });
    evidence.visible = {
      passed: visible.exitCode === 0 && !visible.truncated,
      output: (visible.stdout + visible.stderr).slice(-8000),
    };
    const commits = await sandbox.exec([
      'node',
      '--input-type=module',
      '-e',
      `import {execFileSync as x} from 'node:child_process';const git=a=>x('git',['-c','core.hooksPath=/dev/null',...a],{encoding:'utf8'}).trim();const ids=git(['rev-list','--reverse',process.argv[1]+'..HEAD']).split('\\n').filter(Boolean);console.log(JSON.stringify(Object.fromEntries(ids.map(id=>[id,git(['diff-tree','--no-commit-id','--name-only','-r',id]).split('\\n').filter(Boolean)]))));`,
      commit,
    ]);
    if (commits.exitCode !== 0 || commits.truncated)
      throw Error('Cannot capture commit evidence');
    evidence.commitFiles = JSON.parse(commits.stdout) as Record<string, string[]>;
    const diff = await sandbox.exec([
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      'diff',
      commit,
      '--',
    ]);
    if (diff.exitCode !== 0 || diff.truncated) throw Error('Cannot capture final diff');
    await writeFile(path.join(dir, 'workspace.diff'), diff.stdout);
    await json('evidence.json', evidence);
    await json('team-state.json', team.snapshot());
    await json('usage.json', meter.totals);
    const extra: string[] = claude ? ['claude-code.jsonl'] : [];
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
    for (const a of atEvents) await collect(a.name);
    await seal(dir, extra);
    const audit = await auditRun(dir);
    await json('audit.json', audit);
    const summary: Summary = {
      format: FORMAT,
      schemaVersion: 4,
      runId: config.runId,
      condition: config.condition,
      runtime: identity,
      termination,
      usage: meter.totals,
      durationMs,
      grade: grade({
        trace: engine.trace,
        audit,
        evidence,
        team: team.snapshot(),
        final,
        termination: termination.reason,
        family,
      }),
      audit,
      team: team.snapshot(),
      evidence,
      finalWorkspace: final,
    };
    await json('summary.json', summary);
    await writeFile(path.join(dir, 'report.md'), renderReport(summary));
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
    if (config.keepWorkspace) {
      sandbox.stop();
      await json('workspace-location.json', { path: sandbox.repo });
    } else await sandbox.dispose();
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
