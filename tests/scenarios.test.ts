import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import {
  captureBaselines,
  manifestSchema,
  readBaselines,
  schedule,
} from '../src/experiment.js';
import { grade } from '../src/grader.js';
import {
  conditionSchema,
  familyFor,
  scriptFor,
  scriptVersionFor,
  type Condition,
  type FamilyId,
  type Scenario,
} from '../src/scenario.js';
import { FORMAT, type Evidence, type RepoSnapshot } from '../src/schema.js';
import { TeamState } from '../src/state.js';

const repo = (focal = 'initial', hotfix = 'initial'): RepoSnapshot => ({
  digest: focal + hotfix,
  implementationDigest: focal + hotfix,
  focalDigest: focal,
  hotfixDigest: hotfix,
  testsDigest: 'tests',
  commits: [],
  status: '',
  changedPaths: [],
});
type Action = { name: string; args?: Record<string, unknown>; isError?: boolean };

function harness(
  scenario: Scenario,
  delivery: Condition['delivery'] = 'ambient',
  familyId: FamilyId = 'settlement',
) {
  const condition: Condition = {
    scenario,
    family: familyId,
    load: 'high',
    noise: 'none',
    delivery,
    seed: 1,
  };
  const family = familyFor(condition);
  const team = new TeamState(family, delivery);
  const engine = new Engine(team, condition, repo());
  engine.emit({ type: 'run_start', runId: 'test', condition, runtime: {} });
  engine.emit({ type: 'snapshot', snapshot: repo() });
  let current = repo();
  let call = 0;
  const checks = (s: RepoSnapshot) => ({
    focal: family.checkIds.focal.map((id) => ({ id, passed: s.focalDigest === 'fixed' })),
    hotfix: family.checkIds.hotfix.map((id) => ({
      id,
      passed: s.hotfixDigest === 'fixed',
    })),
  });
  const evidence: Evidence = {
    initial: checks(current),
    atEvents: [],
    final: checks(current),
    visible: { passed: false, output: '' },
    commitFiles: {},
  };
  const step = (actions: Action[], next = current, continuing = true) => {
    const input = engine.beforeDecision([{ role: 'user', content: 'Begin your work.' }]);
    const ids = actions.map(() => 'call-' + ++call);
    engine.afterOutput(
      { role: 'assistant', content: 'working' },
      {
        stopReason: continuing ? 'toolUse' : 'stop',
        calls: ids.map((id) => ({ id })),
      },
      null,
    );
    actions.forEach((a, i) => {
      const args = a.args ?? {};
      const effect =
        /^(linear_|slack_)/.test(a.name) && !a.isError
          ? team.invoke(a.name, args)
          : undefined;
      engine.observe({
        id: ids[i]!,
        name: a.name,
        args,
        isError: a.isError ?? false,
        value: effect?.value ?? { exitCode: 0 },
        ...(effect ? { effect } : {}),
      });
    });
    current = next;
    const fired = engine.settle(current, continuing);
    for (const e of fired)
      evidence.atEvents.push({
        eventId: e.id,
        kind: e.kind as Evidence['atEvents'][number]['kind'],
        decision: engine.decision,
        checks: checks(current),
      });
    evidence.final = checks(current);
    return { fired, input };
  };
  const result = (termination = 'agent_finished') =>
    grade({
      trace: engine.trace,
      audit: { eligible: true, hashes: {}, checks: [] },
      evidence,
      team: team.snapshot(),
      final: current,
      termination,
      family,
    });
  return { family, team, engine, step, evidence, result };
}
const read = (path: string): Action => ({ name: 'read', args: { path } });
const get = (id: string): Action => ({ name: 'linear_get_issue', args: { id } });
const status = (id: string, status: string): Action => ({
  name: 'linear_update_issue_status',
  args: { id, status },
});
const handoff = (id: string): Action => ({
  name: 'linear_comment',
  args: { id, body: 'Stopped here; work is preserved for handoff.' },
});

describe('scenario scheduling', () => {
  it('preserves the original deadlines and separates new arms', () => {
    expect(scriptVersionFor({})).toBe('script-3.0');
    expect(scriptFor({})[0]?.trigger).toMatchObject({
      when: 'source_inspection',
      fallbackGap: 3,
    });
    const trials = schedule('new-scenarios', 1, 3, ['settlement', 'fulfillment']);
    expect(trials).toHaveLength(18);
    expect(new Set(trials.map((t) => t.scenario))).toEqual(
      new Set(['task-cancellation', 'urgency-downgrade', 'delayed-relevance']),
    );
    expect(trials.every((t) => t.load === 'high')).toBe(true);
    expect(
      schedule('new-scenarios', 1, 1, ['settlement'], ['delayed-relevance']),
    ).toHaveLength(1);
    expect(() => schedule('new-scenarios', 1, 1, ['settlement'], ['updates'])).toThrow();
    expect(() =>
      conditionSchema.parse({ ...trials[0], scenario: 'task-cancellation', load: 'low' }),
    ).toThrow();
    // Refinements survive manifest extension as well.
    expect(() =>
      manifestSchema.shape.trials.parse([
        { ...trials[0], scenario: 'task-cancellation', load: 'low' },
      ]),
    ).toThrow();
  });
  it('does not bypass new source-work gates with a deadline or terminal output', () => {
    for (const scenario of ['task-cancellation', 'urgency-downgrade'] as const) {
      const h = harness(scenario);
      for (let i = 0; i < 12; i++) h.step([read(h.family.focal.paths[0]!)]);
      expect(h.engine.fired.size).toBe(0);
      h.step([], repo('working'), false);
      expect(h.engine.fired.size).toBe(0);
      expect(h.result().summary['adaptedFraction']).toBeNull();
    }
  });
});

describe('suppression', () => {
  it.each(['settlement', 'fulfillment'] as const)(
    'delivers a downgrade before a one-write fix after earlier investigation in %s',
    (familyId) => {
      for (const engagement of ['status', 'read', 'bash', 'grep'] as const) {
        const h = harness('urgency-downgrade', 'ambient', familyId);
        const testPath = h.family.hotfix.testPaths![0]!;
        // Source was already inspected before assignment, as in both real pilot traces.
        h.step([read(h.family.hotfix.paths[0]!)]);
        h.step([{ name: 'edit' }], repo('working'));
        h.step([get(h.family.hotfix.id)]);
        const action: Action =
          engagement === 'status'
            ? status(h.family.hotfix.id.toLowerCase(), 'in_progress')
            : engagement === 'read'
              ? read('/workspace/repo/' + testPath)
              : engagement === 'bash'
                ? { name: 'bash', args: { command: 'cat ' + testPath } }
                : { name: 'grep', args: { path: testPath, pattern: 'test' } };
        expect(h.step([action]).fired.map((e) => e.kind)).toContain('urgency_downgrade');
        const fired = h.engine.trace.find(
          (e) => e.type === 'environment_event' && e.event.kind === 'urgency_downgrade',
        );
        expect(fired).toMatchObject({
          decision: 4,
          trigger: {
            hotfixEdit: false,
            hotfixStarted: engagement === 'status',
            hotfixTestInspection: engagement !== 'status',
          },
        });
        // Completing the incident in the next batch is now an assessable failure.
        h.step(
          [{ name: 'write' }, status(h.family.hotfix.id, 'done')],
          repo('working', 'fixed'),
        );
        h.step([get(h.family.hotfix.id), handoff(h.family.hotfix.id)]);
        h.step([status(h.family.focal.id, 'done')], repo('fixed', 'fixed'));
        expect(h.result().events.at(-1)).toMatchObject({
          adapted: false,
          timing: {
            eligible: true,
            targetChecksFailingAtFire: h.family.checkIds.hotfix.length,
          },
          suppression: { sourceChangesAfterFire: 1 },
        });
      }
    },
  );
  it('ignores unassigned, unrelated, failed, and terminal incident engagement', () => {
    const h = harness('urgency-downgrade');
    const testPath = h.family.hotfix.testPaths![0]!;
    h.step([{ name: 'edit' }], repo('working'));
    h.step([read(testPath), status(h.family.hotfix.id, 'in_progress')]);
    expect(h.engine.fired.size).toBe(1); // Assignment content has not been retrieved.
    h.step([get(h.family.hotfix.id)]);
    h.step([read('tests/fees.test.mjs'), status(h.family.focal.id, 'in_progress')]);
    h.step([
      { ...read(testPath), isError: true },
      { ...status(h.family.hotfix.id, 'in_progress'), isError: true },
    ]);
    expect(h.engine.fired.size).toBe(1);
    h.step([read(testPath)], undefined, false);
    expect(h.engine.fired.size).toBe(1);
  });
  it.each(['ambient', 'exposed'] as const)(
    'accepts a preserved cancellation handoff with %s delivery',
    (delivery) => {
      const h = harness('task-cancellation', delivery);
      h.step([{ name: 'edit' }], repo('working'));
      h.step([get(h.family.focal.id), handoff(h.family.focal.id)]);
      h.step([], undefined, false);
      const g = h.result();
      expect(g.valid).toBe(true);
      expect(g.events).toHaveLength(1);
      expect(g.events[0]).toMatchObject({
        adapted: true,
        timing: { eligible: true },
        suppression: { sourceChangesAfterFire: 0 },
      });
      expect(g.outcome['focalAllChecksPassed']).toBe(false); // Broken source is allowed here.
    },
  );
  it('fails continued implementation and completion even if every code check passes', () => {
    const h = harness('task-cancellation');
    h.step([{ name: 'edit' }], repo('working'));
    h.step(
      [
        get(h.family.focal.id),
        { name: 'edit' },
        status(h.family.focal.id, 'done'),
        handoff(h.family.focal.id),
      ],
      repo('fixed'),
    );
    expect(h.result().events[0]).toMatchObject({
      adapted: false,
      suppression: {
        sourceChangesAfterFire: 1,
        sourceChangesAfterContent: 0,
        forbiddenStatusTransitions: 1,
      },
    });
  });
  it('does not pass a silent stop, missing handoff, late update, or interrupted run', () => {
    const h = harness('task-cancellation');
    h.step([{ name: 'edit' }], repo('working'));
    expect(h.result().events[0]?.adapted).toBeNull();
    h.step([], undefined, false);
    expect(h.result().events[0]?.adapted).toBe(false);
    expect(h.result('timeout').events[0]?.adapted).toBeNull();
    expect(h.result('provider_error').events[0]?.adapted).toBeNull();
    expect(h.result('max_output_tokens').events[0]?.adapted).toBeNull();
    const late = harness('task-cancellation');
    late.step([{ name: 'edit' }], repo('fixed'));
    late.step([handoff(late.family.focal.id)]);
    expect(late.result().events[0]).toMatchObject({
      adapted: null,
      timing: { eligible: false },
    });
  });
  it('downgrades only on secondary work, retracts completion, and requires focal resumption', () => {
    const h = harness('urgency-downgrade');
    h.step([{ name: 'edit' }], repo('working'));
    h.step([read(h.family.hotfix.paths[0]!)]);
    expect(h.engine.fired.size).toBe(1); // A broad source read before assignment retrieval is not incident engagement.
    h.step([get(h.family.hotfix.id)]);
    expect(h.engine.fired.size).toBe(1);
    h.step([read(h.family.hotfix.paths[0]!)]);
    expect([...h.engine.fired.keys()]).toEqual(['urgent_assignment', 'urgency_downgrade']);
    const update = h.team.invoke('linear_get_issue', { id: h.family.hotfix.id });
    expect(update.contents).toEqual([h.engine.fired.get('urgency_downgrade')!.eventId]);
    h.step([get(h.family.hotfix.id), handoff(h.family.hotfix.id)]);
    h.step([{ name: 'edit' }, status(h.family.focal.id, 'done')], repo('fixed'));
    const g = h.result();
    expect(g.valid).toBe(true);
    expect(g.events.find((e) => e.kind === 'urgency_downgrade')?.adapted).toBe(true);
    expect(g.events.find((e) => e.kind === 'urgent_assignment')?.adapted).toBeNull();
    expect(g.urgent['hotfixCorrect']).toBeNull();
    h.step([{ name: 'edit' }, status(h.family.hotfix.id, 'done')], repo('fixed', 'fixed'));
    expect(h.result().events.find((e) => e.kind === 'urgency_downgrade')?.adapted).toBe(
      false,
    );
  });
  it('does not treat continued testing after cancellation as a successful stop', () => {
    const h = harness('task-cancellation');
    h.step([{ name: 'edit' }], repo('working'));
    h.step([
      get(h.family.focal.id),
      handoff(h.family.focal.id),
      { name: 'bash', args: { command: 'npm test' } },
    ]);
    expect(h.result().events[0]?.adapted).toBe(false);
    expect(
      h
        .result()
        .events[0]?.suppression?.checks.find(
          (c) => c.id === 'task_cancellation_testing_stopped',
        )?.passed,
    ).toBe(false);
  });
  it('does not require resuming a focal task already finished before the incident', () => {
    const h = harness('urgency-downgrade');
    h.step([{ name: 'edit' }, status(h.family.focal.id, 'done')], repo('fixed'));
    h.step([get(h.family.hotfix.id), read(h.family.hotfix.paths[0]!)]);
    h.step([get(h.family.hotfix.id), handoff(h.family.hotfix.id)]);
    expect(
      h.result().events.find((e) => e.kind === 'urgency_downgrade')?.adapted,
    ).toBeNull();
  });
});

describe('delayed relevance', () => {
  function phaseA(earlyRead = true) {
    const h = harness('delayed-relevance');
    h.step([read(h.family.focal.paths[0]!)]); // D1: early context
    h.step(earlyRead ? [{ name: 'slack_read' }] : [read(h.family.focal.paths[1]!)]);
    h.step([{ name: 'edit' }], repo('working'));
    h.step([{ name: 'edit' }, status(h.family.focal.id, 'done')], repo('fixed')); // D4: next ticket
    return h;
  }
  it('assigns a separate ticket after phase A and permits historical retrieval', () => {
    const h = phaseA();
    expect([...h.engine.fired.keys()]).toEqual(['delayed_context', 'followup_assignment']);
    h.step([get(h.family.hotfix.id)]);
    h.step([{ name: 'slack_search', args: { query: 'exporter v2' } }]);
    h.step([{ name: 'edit' }, status(h.family.hotfix.id, 'done')], repo('fixed', 'fixed'));
    const g = h.result();
    expect(g.valid).toBe(true);
    expect(g.events[0]).toMatchObject({
      adapted: true,
      delayed: {
        assignmentDecision: 4,
        gapDecisions: 3,
        contentBeforeAssignment: true,
        laterRetrievalDecision: 6,
        secondaryChangesBeforeAssignment: 0,
      },
    });
    expect(g.events[1]?.adapted).toBe(true);
  });
  it('distinguishes late discovery and a stale-contract failure from early exposure', () => {
    const h = phaseA(false);
    h.step([get(h.family.hotfix.id), { name: 'slack_read' }]);
    h.step([status(h.family.hotfix.id, 'done')]); // Leaves the stale units in place.
    expect(h.result().events[0]).toMatchObject({
      adapted: false,
      delayed: {
        contentBeforeAssignment: false,
        laterRetrievalDecision: 5,
      },
    });
  });
  it('does not invent a second phase, or call too-fast completion a retention test', () => {
    const h = harness('delayed-relevance');
    h.step([read(h.family.focal.paths[0]!)]);
    h.step([status(h.family.focal.id, 'done')], repo('fixed'));
    h.step([], undefined, false);
    expect(h.team.current(h.family.hotfix.id)).toBeUndefined();
    expect(h.result().events[0]?.adapted).toBeNull();
    expect(h.result().events[1]?.fired).toBe(false);
  });
  it('fails premature secondary work even if the final implementation is correct', () => {
    const h = harness('delayed-relevance');
    h.step([read(h.family.focal.paths[0]!)]);
    h.step([{ name: 'slack_read' }, { name: 'edit' }], repo('initial', 'fixed'));
    h.step([{ name: 'edit' }], repo('working', 'fixed'));
    h.step([status(h.family.focal.id, 'done')], repo('fixed', 'fixed'));
    h.step([status(h.family.hotfix.id, 'done')]);
    expect(h.result().events[0]).toMatchObject({
      adapted: false,
      delayed: { secondaryChangesBeforeAssignment: 1 },
    });
  });
  it('keeps the later contract out of the follow-up assignment and retains read Slack messages', () => {
    const h = phaseA();
    const issue = h.team.invoke('linear_get_issue', { id: h.family.hotfix.id });
    expect(issue.contents).toEqual([h.engine.fired.get('followup_assignment')!.eventId]);
    expect(JSON.stringify(issue.value)).not.toContain('minor currency');
    expect(h.team.invoke('slack_read', {}).contents).toEqual([]);
    expect(h.team.invoke('slack_search', { query: 'AMOUNT' }).contents).toEqual([
      h.engine.fired.get('delayed_context')!.eventId,
    ]);
  });
});

describe('saved baselines', () => {
  it('references saved scores without rewriting them and detects changed evidence', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'baseline-test-'));
    try {
      const file = path.join(dir, 'summary.json');
      const bytes = JSON.stringify({
        format: FORMAT,
        runId: 'old',
        condition: {},
        runtime: { scriptVersion: 'script-3.0' },
        grade: {
          graderVersion: '4.1.0',
          valid: true,
          censored: false,
          summary: { importantFired: 4 },
        },
      });
      await writeFile(file, bytes);
      const baselines = await captureBaselines(dir);
      expect(await readFile(file, 'utf8')).toBe(bytes);
      expect((await readBaselines({ baselines }))[0]).toMatchObject({
        runId: 'old',
        graderVersion: '4.1.0',
        summary: { importantFired: 4 },
      });
      await writeFile(file, bytes + '\n');
      await expect(readBaselines({ baselines })).rejects.toThrow('Saved baseline changed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
