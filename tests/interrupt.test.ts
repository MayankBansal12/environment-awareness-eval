import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { compare, freeze, schedule, summarize } from '../src/experiment.js';
import { conditionSchema, familyFor, scriptFor, type Condition } from '../src/scenario.js';
import { TeamState } from '../src/state.js';
import type { RepoSnapshot } from '../src/schema.js';

const snapshot = (focal = 'initial'): RepoSnapshot => ({
  digest: focal,
  implementationDigest: focal,
  focalDigest: focal,
  hotfixDigest: 'initial',
  testsDigest: 'tests',
  commits: [],
  status: '',
  changedPaths: [],
});

it('publishes at a partial tool boundary and draws noise once per model decision', () => {
  const condition: Condition = {
    family: 'settlement',
    scenario: 'task-cancellation',
    load: 'high',
    noise: 'normal',
    delivery: 'interrupt',
    seed: 2,
  };
  const state = new TeamState(familyFor(condition), 'interrupt');
  const engine = new Engine(state, condition, snapshot());
  engine.beforeDecision([{ role: 'user', content: 'Begin.' }]);
  expect(engine.settle(snapshot())).toEqual([]);
  const events = engine.settle(snapshot('partial'));
  expect(events.map((e) => e.kind)).toEqual(['task_cancellation']);
  expect(state.events.some((e) => !e.important)).toBe(true);
  const count = state.events.length;
  for (let n = 0; n < 10; n++) engine.settle(snapshot('partial'));
  expect(state.events).toHaveLength(count);
  const message = engine.beforeDecision([
    { role: 'user', content: 'New workplace notification.' },
  ])[0]!;
  expect(message.content).toContain('<environment_status>');
  expect(message.content).not.toContain('<notification>');
});

it('keeps noise-only controls separate from actionable events and default history', () => {
  const trials = schedule('interrupt-pilot', 1, 1, ['settlement']);
  expect(trials).toHaveLength(6);
  expect(trials.every((t) => t.delivery === 'interrupt')).toBe(true);
  for (const scenario of ['task-cancellation', 'urgency-downgrade']) {
    const group = trials.filter((t) => t.scenario === scenario);
    expect(group.map((t) => `${t.noise}/${t.updates ?? 'enabled'}`).sort()).toEqual([
      'none/enabled',
      'normal/disabled',
      'normal/enabled',
    ]);
  }
  for (const t of trials.filter((t) => t.updates === 'disabled'))
    expect(scriptFor(t)).toEqual([]);
  expect(schedule('scenario-matrix', 1, 5, ['settlement', 'fulfillment'])).toHaveLength(40);
  expect(conditionSchema.parse({ ...trials[0], delivery: 'ambient' }).delivery).toBe(
    'ambient',
  );
});

it('freezes interrupt configuration and reports six distinct cells without running inference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'interrupt-manifest-'));
  try {
    const file = path.join(root, 'pilot.json');
    const manifest = await freeze(file, {
      id: 'pilot',
      profile: 'interrupt-pilot',
      repetitions: 1,
      seed: 1,
      families: ['settlement'],
      modelConfig: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'default' },
    });
    expect(manifest.scriptVersion).toBe('interrupt-1.0');
    expect(JSON.parse(await readFile(file, 'utf8')).trials).toEqual(manifest.trials);
    const comparison = summarize(
      manifest,
      manifest.trials.map((trial) => ({ trial, attempts: [], summary: null })),
    );
    expect(comparison.cells).toHaveLength(6);
    const failedRun = path.join(root, 'pilot', 'runs', 't001');
    await mkdir(failedRun, { recursive: true });
    await writeFile(
      path.join(failedRun, 'summary.json'),
      JSON.stringify({ termination: { reason: 'harness_error' } }),
    );
    const resumed = await compare(file, root);
    expect(resumed.completed).toBe(0);
    expect(resumed.trials[0]?.attempts).toEqual([{ id: 't001', state: 'harness_error' }]);
    await expect(
      freeze(path.join(root, 'bad.json'), {
        id: 'bad',
        profile: 'interrupt-pilot',
        modelConfig: { provider: 'anthropic', model: 'claude-opus-5', thinking: 'default' },
      }),
    ).rejects.toThrow('requires native Codex');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
