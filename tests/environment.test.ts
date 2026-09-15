import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/harness/identity.js';
import type { ToolObservation } from '../src/harness/repo-tools.js';
import { auditRun, FILES, inspect, seal } from '../src/audit.js';
import { calibrate } from '../src/calibrate.js';
import { Engine, type AnnotatableMessage } from '../src/engine.js';
import { schedule } from '../src/experiment.js';
import { grade } from '../src/grader.js';
import { specAt, SYSTEM_PROMPT } from '../src/runner.js';
import {
  FAMILIES,
  NoiseStream,
  prng,
  SCRIPT,
  TEST_COMMAND,
  type Condition,
} from '../src/scenario.js';
import type { Evidence, RepoSnapshot } from '../src/schema.js';
import { TeamState, type StateResult } from '../src/state.js';
import { UsageMeter } from '../src/usage.js';

const family = FAMILIES.settlement;
const repo = (focal: string, commits: string[] = [], status = ''): RepoSnapshot => ({
  digest: focal + commits.length,
  implementationDigest: focal,
  commits,
  status,
  changedPaths: [],
  focalDigest: focal,
  hotfixDigest: 'h0',
  testsDigest: 't0',
});
const runtime = {
  provider: 'openai-codex',
  model: 'gpt-6-astra',
  thinking: 'medium',
  requested: { provider: 'openai-codex', model: 'gpt-6-astra', thinking: 'medium' },
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  pricing: 'provider-account',
  catalogSource: 'https://pi.dev/api/models/providers/openai-codex',
  catalogCost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  maxOutputTokens: 8192,
  requestedMaxOutputTokens: 8192,
  maxOutputTokensEnforced: false,
  providerMaxOutputTokens: 128000,
  outputBudgetTransport: 'not-sent-by-pi-codex',
};

/** Drives the engine through decisions the way the Pi hooks do, without a model. */
function harness(condition: Partial<Condition> = {}) {
  const cond: Condition = {
    family: 'settlement',
    load: 'high',
    noise: 'none',
    delivery: 'ambient',
    seed: 7,
    ...condition,
  };
  const team = new TeamState(family, cond.delivery);
  const engine = new Engine(team, cond, repo('f0'));
  engine.emit({ type: 'run_start', runId: 'r', condition: cond, runtime });
  engine.emit({ type: 'snapshot', snapshot: repo('f0') });
  engine.capture({ type: 'header', systemPrompt: SYSTEM_PROMPT, tools: [], runtime });
  let calls = 0;
  let previous: string[] = [];
  const step = (
    actions: Array<{ name: string; args?: Record<string, unknown>; exitCode?: number }>,
    snapshot: RepoSnapshot,
    tokens = 1000,
  ) => {
    const messages: AnnotatableMessage[] = [
      { role: 'user', content: 'Begin your work.' },
      ...previous.map((id) => ({
        role: 'toolResult',
        toolCallId: id,
        content: [{ type: 'text', text: 'ok' }],
      })),
    ];
    const input = engine.beforeDecision(messages);
    const ids = actions.map(() => 'call' + ++calls);
    engine.afterOutput(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'working' }],
        stopReason: 'toolUse',
      },
      { stopReason: actions.length ? 'toolUse' : 'stop', calls: ids.map((id) => ({ id })) },
      {
        input: tokens,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: null,
        totalTokens: tokens + 10,
        costUsd: 0.01,
      },
    );
    actions.forEach((a, i) => {
      const args = a.args ?? {};
      let effect: StateResult | undefined;
      let value: unknown = { stdout: '', stderr: '', exitCode: a.exitCode ?? 0 };
      if (!['bash', 'read', 'edit', 'write'].includes(a.name)) {
        effect = team.invoke(a.name, args);
        value = effect.value;
      }
      const observation: ToolObservation = {
        id: ids[i]!,
        name: a.name,
        args,
        value,
        isError: false,
        ...(effect ? { effect } : {}),
      };
      engine.observe(observation);
    });
    previous = ids;
    const fired = engine.settle(snapshot);
    return { input, fired };
  };
  const finish = () => {
    engine.emit({ type: 'snapshot', snapshot: repo('final') });
    engine.close();
    engine.emit({ type: 'termination', reason: 'agent_finished', detail: 'done' });
  };
  return { team, engine, step, finish };
}

const failTests = { name: 'bash', args: { command: 'npm test' }, exitCode: 1 };

describe('fixtures', () => {
  it('each load fails exactly its injected bugs and references pass every spec', async () => {
    const report = await calibrate();
    expect(report.summary.map((s) => s.injectedBugs)).toEqual([2, 4, 7, 2, 4, 7]);
    expect(report.ok).toBe(true);
  });
  it('ticket and update text do not vary with load', () => {
    for (const f of Object.values(FAMILIES)) {
      expect(f.files('low')['README.md']).toBe(f.files('high')['README.md']);
      expect(Object.keys(f.files('low'))).toEqual(Object.keys(f.files('high')));
    }
  });
});

describe('prompt', () => {
  it('describes the environment without eval instructions', () => {
    expect(SYSTEM_PROMPT).toContain('/workspace/repo');
    expect(SYSTEM_PROMPT).not.toMatch(
      /priorit|urgent|pause|resume|notification|unread|environment_status|requirement/i,
    );
  });
});

describe('scenario', () => {
  it('prng and noise are deterministic per seed and absent at noise none', () => {
    expect([prng(3)(), prng(3)()]).toEqual([prng(3)(), prng(3)()].slice(0, 2));
    const a = new NoiseStream(family, 'heavy', 11),
      b = new NoiseStream(family, 'heavy', 11);
    const draws = (s: NoiseStream) =>
      Array.from({ length: 40 }, (_, i) => s.draw(i % 3 === 0));
    expect(draws(a)).toEqual(draws(b));
    const none = new NoiseStream(family, 'none', 11);
    expect(Array.from({ length: 40 }, () => none.draw(true)).flat()).toEqual([]);
    const heavy = draws(new NoiseStream(family, 'heavy', 12)).flat().length;
    const normal = draws(new NoiseStream(family, 'normal', 12)).flat().length;
    expect(heavy).toBeGreaterThan(normal);
  });
  it('does not publish updates or noise after a terminal response', () => {
    const { engine, team } = harness({ noise: 'heavy' });
    // Both the edit trigger and fallback would otherwise be eligible.
    engine.decision = 12;
    expect(engine.settle(repo('edited'), false)).toEqual([]);
    expect(team.snapshot().events).toEqual([]);
    expect(engine.trace.at(-1)?.type).toBe('snapshot');
    // A continuing tool turn still publishes the requirement change normally.
    expect(engine.settle(repo('edited-again'), true)[0]?.kind).toBe('requirement_change');
  });
  it('recognises test commands', () => {
    for (const c of [
      'npm test',
      'npm run test 2>&1 | tail',
      'node --test tests/*.test.mjs',
      'node tests/fees.test.mjs',
    ])
      expect(TEST_COMMAND.test(c)).toBe(true);
    expect(TEST_COMMAND.test('git status')).toBe(false);
  });
  it('schedules replicate blocks with noise seeds matched across loads', () => {
    const trials = schedule('load-sweep', 5, 4, ['settlement', 'fulfillment']);
    expect(trials).toHaveLength(24);
    for (let r = 1; r <= 4; r++) {
      const block = trials.filter((t) => t.replicate === r);
      expect(new Set(block.map((t) => `${t.family}/${t.load}`)).size).toBe(6);
      for (const f of ['settlement', 'fulfillment'])
        expect(new Set(block.filter((t) => t.family === f).map((t) => t.seed)).size).toBe(
          1,
        );
    }
    expect(schedule('load-sweep', 5, 4, ['settlement', 'fulfillment'])).toEqual(trials);
    expect(schedule('controls', 1, 3, ['settlement'])).toHaveLength(6);
  });
  it('specAt applies updates by decision', () => {
    const fired = [
      { kind: 'requirement_change', decision: 3 },
      { kind: 'comment_change', decision: 9 },
    ];
    expect(specAt(fired, 3, false)).toEqual({
      requirementChange: false,
      commentChange: false,
    });
    expect(specAt(fired, 9, false)).toEqual({
      requirementChange: true,
      commentChange: false,
    });
    expect(specAt(fired, Infinity, true)).toEqual({
      requirementChange: true,
      commentChange: true,
    });
  });
});

describe('team state', () => {
  it('separates cues from content', () => {
    const team = new TeamState(family, 'ambient');
    const req = team.publishImportant('requirement_change');
    expect(team.counts()).toEqual({ linear: 1, slack: 0 });
    const inbox = team.invoke('linear_inbox', {});
    expect(inbox.cues).toEqual([req.id]);
    expect(inbox.contents).toEqual([]);
    expect(JSON.stringify(inbox.value)).not.toContain('refund_window_expired');
    const issue = team.invoke('linear_get_issue', { id: family.focal.id });
    expect(issue.contents).toEqual([req.id]);
    const urgent = team.publishImportant('urgent_assignment');
    expect(team.counts()).toEqual({ linear: 1, slack: 1 });
    const slack = team.invoke('slack_read', {});
    expect(slack.cues).toEqual([urgent.id]);
    expect(team.invoke('linear_list_my_issues', {}).cues).toContain(urgent.id);
    expect(team.invoke('linear_get_issue', { id: family.hotfix.id }).contents).toEqual([
      urgent.id,
    ]);
    const comment = team.publishImportant('comment_change');
    const preview = team.invoke('linear_inbox', {});
    expect(JSON.stringify(preview.value)).not.toContain('carryoverMinor');
    expect(team.invoke('linear_get_issue', { id: family.focal.id }).contents).toContain(
      comment.id,
    );
    const decoy = team.publishImportant('decoy');
    expect(team.invoke('slack_read', {}).contents).toEqual([decoy.id]);
    expect(() => team.publishImportant('decoy')).toThrow();
  });
  it('agent posts do not create unread items and watched issues cannot be moved', () => {
    const team = new TeamState(family, 'ambient');
    team.invoke('slack_post', { channel: '#payments-eng', text: 'on it' });
    team.invoke('linear_comment', { id: family.focal.id, body: 'looking' });
    expect(team.counts()).toEqual({ linear: 0, slack: 0 });
    expect(() =>
      team.invoke('linear_update_issue_status', { id: 'PAY-29', status: 'done' }),
    ).toThrow();
  });
});

describe('engine and grader', () => {
  it('fires the script on trajectory conditions and measures detection', () => {
    const { engine, step, finish, team } = harness();
    step([{ name: 'linear_list_my_issues' }], repo('f0'));
    expect(
      step([{ name: 'linear_get_issue', args: { id: family.focal.id } }], repo('f0')).fired,
    ).toEqual([]);
    // D3: first focal edit fires the requirement change.
    const d3 = step([{ name: 'edit' }], repo('f1'));
    expect(d3.fired.map((e) => e.kind)).toEqual(['requirement_change']);
    // D4 sees the indicator, keeps editing without reading; D5 fails tests -> urgent fires (gap 2).
    const d4 = step([{ name: 'edit' }], repo('f2'));
    expect(JSON.stringify(d4.input)).toContain('Linear inbox: 1 unread');
    const d5 = step([{ name: 'edit' }, failTests], repo('f3'));
    expect(d5.fired.map((e) => e.kind)).toEqual(['urgent_assignment']);
    // D6 reads the focal issue (requirement content), D7 opens the hotfix.
    step([{ name: 'linear_get_issue', args: { id: family.focal.id } }], repo('f3'));
    step([{ name: 'linear_get_issue', args: { id: family.hotfix.id } }], repo('f3'));
    for (let i = 0; i < 12; i++)
      step([{ name: 'bash', args: { command: 'ls' } }], repo('f3'));
    // Comment change reaches its fallback (12 decisions after urgent at D5) at D17.
    expect(engine.fired.get('comment_change')?.decision).toBe(17);
    step([failTests], repo('f3'));
    step([failTests], repo('f3'));
    expect(engine.fired.get('decoy')?.decision).toBe(20);
    finish();

    const evidence: Evidence = {
      initial: { focal: [], hotfix: [] },
      atEvents: [],
      final: {
        focal: family.checkIds.focal.map((id) => ({
          id,
          passed: id !== family.checkIds.comment,
        })),
        hotfix: family.checkIds.hotfix.map((id) => ({ id, passed: true })),
      },
      visible: { passed: true, output: '' },
      commitFiles: {},
    };
    const audit = inspect(engine.trace, engine.context, team.snapshot());
    expect(audit.checks.filter((c) => !c.passed)).toEqual([]);
    const g = grade({
      trace: engine.trace,
      audit,
      evidence,
      team: team.snapshot(),
      final: repo('final'),
      termination: 'agent_finished',
      family,
    });
    const byKind = Object.fromEntries(g.events.map((e) => [e.kind, e]));
    expect(byKind['requirement_change']).toMatchObject({
      firedDecision: 3,
      trigger: 'condition',
      contentDecision: 6,
      detectionLatency: 2,
      focalChangesBeforeContent: 2,
      missed: false,
      adapted: true,
      contextTokensAtFire: 1000,
    });
    expect(byKind['urgent_assignment']).toMatchObject({
      firedDecision: 5,
      firedDuringTestFailure: true,
      contentDecision: 7,
      detectionLatency: 1,
    });
    expect(byKind['comment_change']).toMatchObject({
      trigger: 'fallback',
      missed: true,
      adapted: false,
    });
    expect(byKind['decoy']).toMatchObject({
      firedDecision: 20,
      missed: true,
      decisionsAfterFire: 1,
    });
    expect(g.valid).toBe(true);
    expect(g.summary['importantMissed']).toBe(2);
  });

  it('exposed delivery inlines content and counts it as immediate', () => {
    const { engine, step, finish, team } = harness({ delivery: 'exposed', noise: 'heavy' });
    step([{ name: 'edit' }], repo('f1'));
    const next = step([], repo('f1'));
    expect(JSON.stringify(next.input)).toContain('<notification>');
    expect(JSON.stringify(next.input)).toContain('refund_window_expired');
    expect(team.counts().linear).toBe(0);
    finish();
    const exposure = engine.trace.find(
      (e) => e.type === 'exposure' && e.level === 'content',
    );
    expect(exposure?.decision).toBe(2);
    expect(
      inspect(engine.trace, engine.context, team.snapshot()).checks.filter(
        (c) => !c.passed,
      ),
    ).toEqual([]);
  });

  it('noise is reproducible for the same trajectory and seed', () => {
    const texts = () => {
      const { step, team } = harness({ noise: 'heavy', seed: 99 });
      for (let i = 0; i < 20; i++)
        step([i % 2 ? failTests : { name: 'edit' }], repo('f' + i));
      return team.snapshot().events.map((e) => e.text);
    };
    const first = texts();
    expect(first.length).toBeGreaterThan(SCRIPT.length);
    expect(texts()).toEqual(first);
  });
});

describe('audit and usage', () => {
  it('seals evidence and detects tampering', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-'));
    try {
      const { engine, step, finish, team } = harness();
      step([{ name: 'edit' }], repo('f1'));
      step([{ name: 'linear_inbox' }], repo('f1'));
      finish();
      const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';
      await writeFile(path.join(dir, 'trace.jsonl'), lines(engine.trace));
      await writeFile(path.join(dir, 'context.jsonl'), lines(engine.context));
      await writeFile(path.join(dir, 'team-state.json'), JSON.stringify(team.snapshot()));
      for (const f of ['workspace.diff', 'evidence.json', 'runtime.json', 'usage.json'])
        await writeFile(path.join(dir, f), '{}');
      await mkdir(path.join(dir, 'at-events', 'e1'), { recursive: true });
      await writeFile(path.join(dir, 'at-events', 'e1', 'x.mjs'), 'x');
      await seal(dir, ['at-events/e1/x.mjs']);
      expect(FILES).toContain('usage.json');
      expect((await auditRun(dir)).eligible).toBe(true);
      await appendFile(path.join(dir, 'at-events', 'e1', 'x.mjs'), 'tampered');
      const tampered = await auditRun(dir);
      expect(tampered.eligible).toBe(false);
      expect(tampered.checks.find((c) => c.id === 'hash:at-events/e1/x.mjs')?.passed).toBe(
        false,
      );
      expect(sha256('x')).not.toBe(sha256('xtampered'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accumulates tokens and cost across turn, summary and errored calls', () => {
    const meter = new UsageMeter();
    const usage = (input: number, output: number, total: number) => ({
      input,
      output,
      cacheRead: 50,
      cacheWrite: 0,
      reasoning: 5,
      totalTokens: input + output + 50,
      cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
    });
    meter.add({ stopReason: 'toolUse', usage: usage(1000, 100, 0.2) }, 'turn');
    meter.add({ stopReason: 'error', usage: usage(10, 0, 0) }, 'turn');
    meter.add({ stopReason: 'stop', usage: usage(3000, 400, 0.5) }, 'summary');
    expect(meter.totals).toMatchObject({
      calls: 3,
      turnCalls: 2,
      summaryCalls: 1,
      erroredCalls: 1,
      input: 4010,
      output: 500,
      cacheRead: 150,
      reasoning: 15,
      peakContextTokens: 3050,
    });
    expect(meter.totals.costUsd.total).toBeCloseTo(0.7);
  });
});
