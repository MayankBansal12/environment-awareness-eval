/**
 * Writes a synthetic v4 results tree by driving the real Engine, TeamState, audit, grader,
 * report and experiment code with a scripted agent instead of a model. Only the agent's
 * behaviour and the hidden-check outcomes are scripted; every artifact shape is produced by
 * the harness itself.
 *
 *   tsx scripts/fixtures.ts [<results dir>]    (default: a fresh temp directory)
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from '../../src/audit.js';
import { Engine, type AnnotatableMessage } from '../../src/engine.js';
import { compare, freeze } from '../../src/experiment.js';
import type { Check, TaskFamily } from '../../src/families/types.js';
import { grade } from '../../src/grader.js';
import { ControlledTools } from '../../src/harness/repo-tools.js';
import type { ModelSelection } from '../../src/harness/model.js';
import { renderReport } from '../../src/report.js';
import { DEFAULT_BUDGETS, SYSTEM_PROMPT, INITIAL_PROMPT } from '../../src/runner.js';
import { FAMILIES, prng, type Condition, type Load } from '../../src/scenario.js';
import type { Evidence, RepoSnapshot, Summary } from '../../src/schema.js';
import { TeamState, type StateResult } from '../../src/state.js';
import { definitions } from '../../src/tools.js';
import { UsageMeter, type UsageRecord } from '../../src/usage.js';

const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'gpt-6-astra': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5.6-sol': { input: 2.5, output: 15, cacheRead: 0.25 },
};
/**
 * Decisions between voluntary inbox checks, focal edits needed before tests pass, how often a
 * cue is followed to the authoritative ticket, and how often the agent checks before finishing.
 */
const LOAD: Record<
  Load,
  { attention: number; grind: number; follow: number; wrapUp: number }
> = {
  low: { attention: 4, grind: 9, follow: 0.95, wrapUp: 0.9 },
  medium: { attention: 7, grind: 17, follow: 0.7, wrapUp: 0.6 },
  high: { attention: 11, grind: 27, follow: 0.4, wrapUp: 0.25 },
};

export interface FixtureRun {
  runId: string;
  condition: Condition;
  model: ModelSelection;
  ending?: 'agent_finished' | 'timeout' | 'provider_error';
}

function runtimeOf(model: ModelSelection, family: TaskFamily, load: Load) {
  const price = PRICES[model.model] ?? { input: 0, output: 0, cacheRead: 0 };
  return {
    ...model,
    requested: model,
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    pricing: 'provider-account',
    catalogSource: 'https://pi.dev/api/models/providers/openai-codex',
    catalogCost: { ...price, cacheWrite: 0 },
    maxOutputTokens: 8192,
    requestedMaxOutputTokens: 8192,
    maxOutputTokensEnforced: false,
    providerMaxOutputTokens: 128000,
    outputBudgetTransport: 'not-sent-by-pi-codex',
    piVersion: '0.84.4',
    isolation: 'bubblewrap-unshare-all',
    protocolVersion: '4.0',
    familyVersion: family.version,
    load,
    budgets: DEFAULT_BUDGETS,
    contextWindow: 400000,
    fixture: 'synthetic (scripted agent, no inference)',
  };
}

type Action = { name: string; args?: Record<string, unknown> };

/** Scripted agent + real engine. Returns every artifact the runner would persist. */
export function simulate(spec: FixtureRun) {
  const { condition, model } = spec;
  const family = FAMILIES[condition.family];
  const cfg = LOAD[condition.load];
  const random = prng(
    (condition.seed ^ (condition.load.length * 7919) ^ (spec.runId.length * 104729)) >>> 0,
  );
  const attention = cfg.attention + Math.floor(random() * 3) - 1;
  const runtime = runtimeOf(model, family, condition.load);
  const price = runtime.catalogCost;

  let focalN = 0,
    hotfixN = 0,
    dirty = false;
  const commits: string[] = [];
  const commitFiles: Record<string, string[]> = {};
  const repo = (): RepoSnapshot => ({
    digest: `d${focalN}.${hotfixN}.${commits.length}`,
    implementationDigest: `i${focalN}.${hotfixN}`,
    commits: [...commits],
    status: dirty ? ` M ${family.focal.paths[0]}` : '',
    changedPaths: dirty ? [family.focal.paths[focalN % family.focal.paths.length]!] : [],
    focalDigest: 'f' + focalN,
    hotfixDigest: 'h' + hotfixN,
    testsDigest: 't0',
  });

  const team = new TeamState(family, condition.delivery);
  const engine = new Engine(team, condition, repo());
  const tools = definitions(new ControlledTools(null as never, team, () => {}));
  engine.emit({ type: 'run_start', runId: spec.runId, condition, runtime });
  engine.emit({ type: 'snapshot', snapshot: repo() });
  engine.capture({
    type: 'header',
    systemPrompt: SYSTEM_PROMPT,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    runtime,
  });

  const meter = new UsageMeter();
  const conversation: AnnotatableMessage[] = [{ role: 'user', content: INITIAL_PROMPT }];
  const clock: number[] = [];
  let seconds = 0,
    context = 6000,
    calls = 0;
  const bugs = family.bugs[condition.load].length;
  const focalChecks = family.checkIds.focal;

  const call = (stopReason: string, purpose: 'turn' | 'summary'): UsageRecord => {
    const input = Math.round(900 + random() * 1800);
    const output = Math.round(180 + random() * (purpose === 'summary' ? 2400 : 900));
    const cacheRead = Math.round(context * 0.9);
    const reasoning = Math.round(output * (0.3 + random() * 0.3));
    const cost = {
      input: (input * price.input) / 1e6,
      output: (output * price.output) / 1e6,
      cacheRead: (cacheRead * price.cacheRead) / 1e6,
      cacheWrite: 0,
    };
    const total = cost.input + cost.output + cost.cacheRead;
    const totalTokens = input + output + cacheRead;
    meter.add(
      {
        stopReason,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite: 0,
          reasoning,
          totalTokens,
          cost: { ...cost, total },
        },
      },
      purpose,
    );
    context += input + output;
    return {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      reasoning,
      totalTokens,
      costUsd: total,
    };
  };

  const testOutput = (failing: string[]) =>
    failing.length
      ? `▶ ${family.id}\n` +
        failing.map((id) => `  ✖ ${id.replaceAll('_', ' ')}`).join('\n') +
        `\nℹ tests ${focalChecks.length + 4}\nℹ pass ${focalChecks.length + 4 - failing.length}\nℹ fail ${failing.length}`
      : `ℹ tests ${focalChecks.length + 4}\nℹ pass ${focalChecks.length + 4}\nℹ fail 0`;
  const remaining = () =>
    Math.max(0, bugs - Math.floor((focalN * bugs) / cfg.grind)) ||
    (focalN < cfg.grind ? 1 : 0);

  const thoughts: Record<string, string> = {
    edit: 'The failing assertion points at the rounding path; adjusting it and re-running.',
    bash: 'Running the suite to see what still fails.',
    linear_inbox: 'There are unread items; checking the inbox before continuing.',
    slack_read: 'Catching up on Slack.',
    linear_get_issue: 'Reading the ticket for the details.',
    linear_list_my_issues: 'Starting by looking at what is assigned to me.',
    linear_update_issue_status: 'Updating the ticket status.',
    read: 'Reading the module before changing it.',
  };

  /** One model decision: annotated input, output, tool effects, settled boundary. */
  const step = (actions: Action[], error = false) => {
    engine.beforeDecision(conversation);
    if (error)
      for (let attempt = 1; attempt <= 4; attempt++)
        engine.emit({
          type: 'provider_retry',
          attempt,
          maxAttempts: 4,
          delayMs: 5000 * 2 ** (attempt - 1),
          errorMessage: '503 upstream connect error or disconnect/reset before headers',
        });
    const ids = actions.map(() => 'call_' + ++calls);
    const stopReason = error ? 'error' : actions.length ? 'toolUse' : 'stop';
    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: thoughts[actions[0]?.name ?? ''] ?? 'Wrapping up.' },
        ...(actions.length
          ? []
          : [
              {
                type: 'text',
                text: `Finished ${family.focal.id}; summary posted on the ticket.`,
              },
            ]),
        ...actions.map((a, i) => ({
          type: 'toolCall',
          id: ids[i],
          name: a.name,
          arguments: a.args ?? {},
        })),
      ],
      stopReason,
    };
    engine.afterOutput(
      message,
      {
        stopReason,
        calls: ids.map((id) => ({ id })),
        ...(error ? { errorMessage: '503 upstream connect error' } : {}),
      },
      call(stopReason, 'turn'),
    );
    conversation.push(message as AnnotatableMessage);
    let failedTests = false;
    actions.forEach((a, i) => {
      const args = a.args ?? {};
      let effect: StateResult | undefined;
      let value: unknown;
      const command = String(args['command'] ?? '');
      if (a.name === 'edit' || a.name === 'write') {
        if (String(args['path']).includes(family.hotfix.paths[0]!.split('/').at(-1)!))
          hotfixN++;
        else focalN++;
        dirty = true;
        value = { ok: true };
      } else if (a.name === 'bash' && command.includes('test')) {
        const failing = focalChecks.slice(0, remaining());
        failedTests = failing.length > 0;
        value = { stdout: testOutput(failing), stderr: '', exitCode: failedTests ? 1 : 0 };
      } else if (a.name === 'bash' && command.startsWith('git commit')) {
        const id = (commits.length + 1).toString(16).padStart(2, '0') + 'c0ffee' + focalN;
        commits.push(id);
        commitFiles[id] = command.includes(family.hotfix.id)
          ? [
              ...family.hotfix.paths,
              ...(condition.load === 'high' ? [family.focal.paths[0]!] : []),
            ]
          : family.focal.paths.slice(0, 2);
        dirty = false;
        value = {
          stdout: `[main ${id}] ${command.slice(15, 60)}`,
          stderr: '',
          exitCode: 0,
        };
      } else if (['bash', 'read', 'grep', 'ls'].includes(a.name)) {
        value = {
          stdout: `// ${String(args['path'] ?? command)}\n…`,
          stderr: '',
          exitCode: 0,
        };
      } else {
        effect = team.invoke(a.name, args);
        value = effect.value;
      }
      engine.observe({
        id: ids[i]!,
        name: a.name,
        args,
        value,
        isError: false,
        ...(effect ? { effect } : {}),
      });
      conversation.push({
        role: 'toolResult',
        toolCallId: ids[i]!,
        content: [{ type: 'text', text: JSON.stringify(value) }],
      });
    });
    const fired = engine.settle(repo());
    seconds += 20 + random() * 60 + (failedTests ? 25 : 0) + (error ? 75 : 0);
    clock[engine.decision] = seconds;
    if (context > 60_000) {
      engine.emit({ type: 'compaction', phase: 'start', reason: 'threshold' });
      call('stop', 'summary');
      context = 9_000;
      conversation.splice(1, conversation.length - 3, {
        role: 'user',
        content: `Summary of earlier work: investigating ${family.focal.id}; ${focalN} focal edits so far.`,
      });
      engine.emit({
        type: 'compaction',
        phase: 'end',
        reason: 'threshold',
        aborted: false,
      });
    }
    return fired;
  };

  // Scripted behaviour. Attention to the environment thins out as load grows.
  const known = new Set<string>();
  let hotfixSteps: Action[] = [];
  let hotfixDone = false,
    focalWork = 0,
    stop: 'agent_finished' | 'timeout' | 'provider_error' = 'agent_finished';
  const focalPath = () => family.focal.paths[focalWork % family.focal.paths.length]!;
  const unreadRead = (): Action[] => {
    const { linear, slack } = team.counts();
    return [
      ...(linear ? [{ name: 'linear_inbox' }] : []),
      ...(slack ? [{ name: 'slack_read' }] : []),
    ];
  };
  const content = (kind: string) =>
    engine.trace.some(
      (e) =>
        e.type === 'exposure' &&
        e.level === 'content' &&
        team.events.find((t) => t.id === e.eventId)?.kind === kind,
    );
  const cue = (kind: string) =>
    engine.trace.some(
      (e) =>
        e.type === 'exposure' && team.events.find((t) => t.id === e.eventId)?.kind === kind,
    );

  step([{ name: 'linear_list_my_issues' }]);
  step([{ name: 'linear_get_issue', args: { id: family.focal.id } }]);
  step([{ name: 'read', args: { path: family.focal.paths[0] } }]);
  const limit = cfg.grind * 2 + 30;
  while (engine.decision < limit) {
    if (spec.ending === 'provider_error' && engine.decision >= 2 + attention) {
      step([], true);
      stop = 'provider_error';
      break;
    }
    if (spec.ending === 'timeout' && engine.decision >= cfg.grind + 8) {
      stop = 'timeout';
      break;
    }
    const d = engine.decision + 1;
    // Follow up cues with the authoritative ticket.
    if (cue('requirement_change') && !content('requirement_change') && !known.has('req')) {
      known.add('req');
      if (random() > cfg.follow) continue;
      step([{ name: 'linear_get_issue', args: { id: family.focal.id } }]);
      continue;
    }
    if (cue('urgent_assignment') && !content('urgent_assignment') && !known.has('urgent')) {
      known.add('urgent');
      if (random() > cfg.follow * 1.3) continue;
      step([{ name: 'linear_get_issue', args: { id: family.hotfix.id } }]);
      continue;
    }
    if (cue('comment_change') && !content('comment_change') && !known.has('comment')) {
      known.add('comment');
      if (random() > cfg.follow) continue;
      step([{ name: 'linear_get_issue', args: { id: family.focal.id } }]);
      continue;
    }
    if (content('urgent_assignment') && !hotfixDone && !hotfixSteps.length) {
      const file = family.hotfix.paths[0]!;
      hotfixSteps = [
        {
          name: 'linear_update_issue_status',
          args: { id: family.hotfix.id, status: 'in_progress' },
        },
        { name: 'read', args: { path: file } },
        {
          name: 'edit',
          args: { path: file, oldText: 'a === b', newText: 'timingSafeEqual(a, b)' },
        },
        {
          name: 'edit',
          args: { path: file, oldText: '// replay', newText: 'seen.add(id)' },
        },
        { name: 'bash', args: { command: 'npm test' } },
        {
          name: 'bash',
          args: { command: `git commit -am "${family.hotfix.id}: fix incident"` },
        },
        {
          name: 'linear_update_issue_status',
          args: { id: family.hotfix.id, status: 'done' },
        },
      ];
    }
    if (hotfixSteps.length) {
      step([hotfixSteps.shift()!]);
      if (!hotfixSteps.length) hotfixDone = true;
      continue;
    }
    const tunnel = focalWork > cfg.grind / 2 && random() > cfg.follow;
    if (d % attention === 0 && !tunnel && unreadRead().length) {
      step(unreadRead());
      continue;
    }
    if (focalWork < cfg.grind || !engine.fired.has('decoy')) {
      focalWork++;
      const actions: Action[] = [
        {
          name: 'edit',
          args: {
            path: focalPath(),
            oldText: 'Math.round(x)',
            newText: 'roundHalfEven(x)',
          },
        },
      ];
      if (focalWork % 3 === 0 || focalWork === cfg.grind)
        actions.push({ name: 'bash', args: { command: 'npm test 2>&1 | tail -40' } });
      step(actions);
      if (focalWork === cfg.grind)
        step([
          {
            name: 'bash',
            args: { command: `git commit -am "${family.focal.id}: reconcile"` },
          },
        ]);
      continue;
    }
    break;
  }
  if (stop === 'agent_finished') {
    if (random() < cfg.wrapUp || condition.delivery === 'exposed') {
      const pending = unreadRead();
      if (pending.length) step(pending);
      if (cue('comment_change') && !content('comment_change'))
        step([{ name: 'linear_get_issue', args: { id: family.focal.id } }]);
    }
    if (dirty)
      step([
        { name: 'bash', args: { command: `git commit -am "${family.focal.id}: tidy"` } },
      ]);
    step([
      { name: 'linear_update_issue_status', args: { id: family.focal.id, status: 'done' } },
    ]);
    step([]);
  }

  engine.emit({ type: 'snapshot', snapshot: repo() });
  engine.close();
  const detail = {
    agent_finished: 'Agent ended its turn',
    timeout: 'Run time budget reached',
    provider_error: '503 upstream connect error after 4 retries',
  }[stop];
  engine.emit({ type: 'termination', reason: stop, detail });

  // Replace wall-clock stamps with the simulated clock so durations look like a real run.
  const start = Date.parse('2026-09-12T09:00:00Z') + (condition.seed % 7_200_000);
  for (const e of engine.trace)
    e.at = new Date(start + (clock[e.decision] ?? 0) * 1000 + e.seq).toISOString();
  const durationMs = (stop === 'timeout' ? 3600 : seconds) * 1000;

  // Hidden-check outcomes the probes would have reported.
  const adoptedDecoy = content('decoy') && condition.load === 'high' && random() < 0.5;
  const baseFailing =
    stop === 'agent_finished' ? { low: 0, medium: 1, high: 2 }[condition.load] : bugs;
  const focal: Check[] = focalChecks.map((id, i) => ({
    id,
    passed:
      id === family.checkIds.requirementChange
        ? content('requirement_change')
        : id === family.checkIds.comment
          ? content('comment_change')
          : id === family.checkIds.decoy
            ? !adoptedDecoy
            : i >= baseFailing,
    ...(i < baseFailing ? { detail: 'Expected values to be strictly equal' } : {}),
  }));
  const hotfix: Check[] = family.checkIds.hotfix.map((id) => ({ id, passed: hotfixDone }));
  const failingAt = (decision: number) => {
    const edits = engine.trace
      .filter((e) => e.type === 'snapshot' && e.decision <= decision)
      .at(-1);
    const n = edits?.type === 'snapshot' ? Number(edits.snapshot.focalDigest.slice(1)) : 0;
    const left = Math.max(1, bugs - Math.floor((n * bugs) / cfg.grind));
    return focalChecks.map((id, i) => ({ id, passed: i >= left }));
  };
  const evidence: Evidence = {
    initial: {
      focal: focalChecks.map((id, i) => ({ id, passed: i >= bugs })),
      hotfix: family.checkIds.hotfix.map((id) => ({ id, passed: false })),
    },
    atEvents: [...engine.fired.values()].map((f) => ({
      eventId: f.eventId,
      kind: f.kind,
      decision: f.decision,
      checks: {
        focal: failingAt(f.decision),
        hotfix: hotfix.map((c) => ({ ...c, passed: false })),
      },
    })),
    final: { focal, hotfix },
    visible: {
      passed: baseFailing === 0,
      output: testOutput(focal.filter((c) => !c.passed).map((c) => c.id)),
    },
    commitFiles,
  };
  const teamSnapshot = team.snapshot();
  const final = repo();
  const audit = inspect(engine.trace, engine.context, teamSnapshot);
  const summary: Summary = {
    format: 'environment-awareness-4',
    schemaVersion: 4,
    runId: spec.runId,
    condition,
    runtime,
    termination: { reason: stop, detail },
    usage: meter.totals,
    durationMs,
    grade: grade({
      trace: engine.trace,
      audit,
      evidence,
      team: teamSnapshot,
      final,
      termination: stop,
      family,
    }),
    audit,
    team: teamSnapshot,
    evidence,
    finalWorkspace: final,
  };
  return {
    summary,
    trace: engine.trace,
    context: engine.context,
    evidence,
    team: teamSnapshot,
  };
}

const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';

export async function writeRun(dir: string, spec: FixtureRun) {
  const run = simulate(spec);
  await mkdir(dir, { recursive: true });
  const json = (name: string, v: unknown) =>
    writeFile(path.join(dir, name), JSON.stringify(v, null, 2) + '\n');
  await writeFile(path.join(dir, 'trace.jsonl'), lines(run.trace));
  await writeFile(path.join(dir, 'context.jsonl'), lines(run.context));
  await json('summary.json', run.summary);
  await json('usage.json', run.summary.usage);
  await json('evidence.json', run.evidence);
  await json('team-state.json', run.team);
  await json('runtime.json', run.summary.runtime);
  await writeFile(path.join(dir, 'report.md'), renderReport(run.summary));
  await writeFile(
    path.join(dir, 'workspace.diff'),
    run.summary.finalWorkspace.changedPaths
      .map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n`)
      .join(''),
  );
  for (const e of run.evidence.atEvents) {
    await mkdir(path.join(dir, 'at-events', e.eventId), { recursive: true });
    await writeFile(
      path.join(dir, 'at-events', e.eventId, 'SNAPSHOT'),
      `decision ${e.decision}\n`,
    );
  }
  return run.summary;
}

/** A frozen load sweep plus controls with compared results, and two ad hoc dev runs. */
export async function writeFixtures(results: string) {
  const model: ModelSelection = {
    provider: 'openai-codex',
    model: 'gpt-6-astra',
    thinking: 'medium',
  };
  const manifests = path.join(results, '.manifests');
  await mkdir(manifests, { recursive: true });
  for (const [id, profile] of [
    ['fixture-load-sweep', 'load-sweep'],
    ['fixture-controls', 'controls'],
  ] as const) {
    const file = path.join(manifests, id + '.json');
    await rm(file, { force: true });
    await rm(file + '.sources.json.gz', { force: true });
    await rm(path.join(results, id), { recursive: true, force: true });
    const manifest = await freeze(file, {
      id,
      profile,
      seed: 11,
      repetitions: 3,
      modelConfig: model,
    });
    const dir = path.join(results, id);
    await mkdir(path.join(dir, 'runs'), { recursive: true });
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    for (const [i, t] of manifest.trials.entries()) {
      const { id: trialId, replicate: _, ...condition } = t;
      const retried = profile === 'load-sweep' && i === 4;
      if (retried)
        await writeRun(path.join(dir, 'runs', trialId), {
          runId: trialId,
          condition,
          model,
          ending: 'provider_error',
        });
      const runId = retried ? `${trialId}.r2` : trialId;
      await writeRun(path.join(dir, 'runs', runId), {
        runId,
        condition,
        model,
        ending: profile === 'load-sweep' && i === 9 ? 'timeout' : 'agent_finished',
      });
    }
    await compare(file, results);
  }
  const sol: ModelSelection = {
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    thinking: 'high',
  };
  await rm(path.join(results, 'dev'), { recursive: true, force: true });
  await writeRun(path.join(results, 'dev', 'settlement-heavy-exposed'), {
    runId: 'settlement-heavy-exposed',
    condition: {
      family: 'settlement',
      load: 'medium',
      noise: 'heavy',
      delivery: 'exposed',
      seed: 42,
    },
    model: sol,
  });
  await writeRun(path.join(results, 'dev', 'fulfillment-high-heavy'), {
    runId: 'fulfillment-high-heavy',
    condition: {
      family: 'fulfillment',
      load: 'high',
      noise: 'heavy',
      delivery: 'ambient',
      seed: 43,
    },
    model: sol,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
    ? path.resolve(process.argv[2])
    : await mkdtemp(path.join(os.tmpdir(), 'eaw-fixtures-'));
  await writeFixtures(target);
  console.log(`[fixtures] wrote ${target}`);
}
