import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExperimentEngine, SlackState } from '../src/engine/experiment.js';
import { getScenario } from '../src/scenarios/catalog.js';
import type { TraceEvent } from '../src/trace/schema.js';
import { gitOrThrow } from '../src/workspace/git.js';
import { disposeWorkspace, prepareWorkspace } from '../src/workspace/manager.js';
import { takeSnapshot, type WorkspaceSnapshot } from '../src/workspace/snapshot.js';

function snap(digest: string, mutated: boolean): WorkspaceSnapshot {
  return {
    headCommit: 'a'.repeat(40),
    commitsAheadOfFixture: 0,
    commits: [],
    sourceMutated: mutated,
    workingTreeDirty: mutated,
    statusPorcelain: mutated ? ' M src/a.ts' : '',
    trackedSourceDigest: digest,
    changedWatchedFiles: mutated ? ['src/a.ts'] : [],
    untrackedWatchedFiles: [],
    changedFiles: mutated ? ['src/a.ts'] : [],
    untrackedFiles: [],
  };
}

describe('ExperimentEngine boundary protocol', () => {
  it('exposes ambient content only after the matching read and fires once', async () => {
    const slack = new SlackState();
    slack.post({
      sender: 'Maya',
      senderRole: 'ticket_owner',
      text: 'ticket',
      mentionsAgent: true,
      logicalTime: -1,
    });
    slack.readUnread();
    const traces: TraceEvent[] = [];
    let current = snap('base', false);
    const engine = new ExperimentEngine({
      scenario: getScenario('cancel-ambient'),
      slack,
      sink: (event) => traces.push(event),
      snapshot: async () => current,
      steer: async () => {},
      limits: { maxTurns: 20, maxActions: 40 },
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });

    const initial = engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    expect(initial[0]?.content).toContain('unread="0"');

    engine.observeTool({
      toolCallId: 'edit-1',
      toolName: 'edit',
      input: { path: 'src/a.ts' },
      outputText: 'ok',
      isError: false,
      batchId: 'turn-0',
      siblingOrdinal: 0,
    });
    current = snap('changed', true);
    await engine.settleTurn({
      turnIndex: 0,
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['edit'],
    });

    const badge = engine.decisionBoundary([
      { role: 'user', content: 'Begin.' },
      { role: 'toolResult', toolCallId: 'edit-1', content: 'ok' },
    ]);
    const badgeText = JSON.stringify(badge);
    expect(badgeText).toContain('unread=\\\"1\\\"');
    expect(badgeText).not.toContain('Priya is handling it');

    const read = slack.readUnread();
    const action = engine.observeTool({
      toolCallId: 'read-1',
      toolName: 'read_slack_messages',
      input: {},
      outputText: JSON.stringify(read),
      isError: false,
      batchId: 'turn-1',
      siblingOrdinal: 0,
    });
    engine.observeSlackRead(
      action,
      read.map((message) => message.id),
      slack.readCursor,
    );
    await engine.settleTurn({
      turnIndex: 1,
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['read_slack_messages'],
    });
    engine.decisionBoundary([
      { role: 'user', content: 'Begin.' },
      { role: 'toolResult', toolCallId: 'read-1', content: JSON.stringify(read) },
    ]);

    expect(
      traces.filter((event) => event.type === 'environment_event_created'),
    ).toHaveLength(1);
    expect(traces.filter((event) => event.type === 'trigger_fired')).toHaveLength(1);
    expect(
      traces.filter(
        (event) =>
          event.type === 'environment_exposure' && event.exposureKind === 'indicator',
      ),
    ).toHaveLength(1);
    expect(
      traces.filter(
        (event) =>
          event.type === 'environment_exposure' && event.exposureKind === 'content',
      ),
    ).toHaveLength(1);
    const actions = traces.filter((event) => event.type === 'tool_action');
    expect(actions.map((event) => [event.batchId, event.siblingOrdinal])).toEqual([
      ['turn-0', 0],
      ['turn-1', 0],
    ]);
  });

  it('does not claim exposed content placement without an anchor', async () => {
    const slack = new SlackState();
    const traces: TraceEvent[] = [];
    let current = snap('base', false);
    const engine = new ExperimentEngine({
      scenario: getScenario('cancel-exposed'),
      slack,
      sink: (event) => traces.push(event),
      snapshot: async () => current,
      steer: async () => {},
      limits: { maxTurns: 5, maxActions: 5 },
    });
    engine.observeTool({
      toolCallId: 'e',
      toolName: 'edit',
      input: {},
      outputText: 'ok',
      isError: false,
    });
    current = snap('changed', true);
    await engine.settleTurn({
      turnIndex: 0,
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['edit'],
    });
    engine.decisionBoundary([{ role: 'assistant', content: [] }]);
    expect(
      traces.some(
        (event) =>
          event.type === 'environment_exposure' && event.exposureKind === 'content',
      ),
    ).toBe(false);
  });
});

describe('workspace snapshots and disposable clones', () => {
  it('detects tracked and untracked source changes and preserves the fixture', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'eaw-fixture-test-'));
    await mkdir(path.join(fixture, 'src'));
    await writeFile(path.join(fixture, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(fixture, 'package.json'), '{"version":"1.0.0"}\n');
    await gitOrThrow(fixture, ['init', '-b', 'main']);
    await gitOrThrow(fixture, ['config', 'user.name', 'Test']);
    await gitOrThrow(fixture, ['config', 'user.email', 'test@example.invalid']);
    await gitOrThrow(fixture, ['add', '.']);
    await gitOrThrow(fixture, ['commit', '-m', 'fixture']);
    const commit = (await gitOrThrow(fixture, ['rev-parse', 'HEAD'])).trim();

    const prepared = await prepareWorkspace({
      sourcePath: fixture,
      expectedCommit: commit,
      runId: 'workspace-test',
      dependencyMode: 'none',
    });
    const clean = await takeSnapshot(prepared.path, commit);
    expect(clean.sourceMutated).toBe(false);
    await writeFile(path.join(prepared.path, 'src/a.ts'), 'export const a = 2;\n');
    await mkdir(path.join(prepared.path, 'tests'));
    await writeFile(path.join(prepared.path, 'tests/new.test.ts'), 'test();\n');
    await writeFile(path.join(prepared.path, 'package.json'), '{"version":"2.0.0"}\n');
    await mkdir(path.join(prepared.path, 'notes'));
    await writeFile(path.join(prepared.path, 'notes/run.txt'), 'untracked\n');
    await gitOrThrow(prepared.path, ['add', 'package.json']);
    await gitOrThrow(prepared.path, ['commit', '-m', 'change config']);
    const changed = await takeSnapshot(prepared.path, commit);
    expect(changed.changedWatchedFiles).toContain('src/a.ts');
    expect(changed.untrackedWatchedFiles).toContain('tests/new.test.ts');
    expect(changed.changedFiles).toEqual([
      'notes/run.txt',
      'package.json',
      'src/a.ts',
      'tests/new.test.ts',
    ]);
    expect(changed.untrackedFiles).toEqual(['notes/run.txt', 'tests/new.test.ts']);
    expect(changed.trackedSourceDigest).not.toBe(clean.trackedSourceDigest);
    expect((await gitOrThrow(fixture, ['status', '--porcelain'])).trim()).toBe('');
    await disposeWorkspace(prepared.path);
  });
});
