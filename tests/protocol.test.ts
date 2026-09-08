/**
 * Protocol-level tests: delivery salience, batch boundaries, indicator persistence and
 * workspace confinement. All deterministic; no model inference.
 */

import { describe, expect, it } from 'vitest';

import { ExperimentEngine, SlackState } from '../src/engine/experiment.js';
import type { AnnotatableMessage } from '../src/engine/environment.js';
import { CANCELLATION_TEXT } from '../src/scenarios/messages.js';
import { getScenario } from '../src/scenarios/catalog.js';
import { guardToolCall, isInside } from '../src/tools/path-guard.js';
import type { TraceEvent } from '../src/trace/schema.js';
import type { WorkspaceSnapshot } from '../src/workspace/snapshot.js';

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

interface Harness {
  engine: ExperimentEngine;
  slack: SlackState;
  traces: TraceEvent[];
  steered: string[];
  setSnapshot: (snapshot: WorkspaceSnapshot) => void;
}

function harness(scenarioId: string): Harness {
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
  const steered: string[] = [];
  let current = snap('base', false);
  const engine = new ExperimentEngine({
    scenario: getScenario(scenarioId),
    slack,
    sink: (event) => traces.push(event),
    snapshot: async () => current,
    steer: async (text) => {
      steered.push(text);
    },
    limits: { maxTurns: 20, maxActions: 60 },
    now: () => new Date('2024-01-01T00:00:00.000Z'),
  });
  return {
    engine,
    slack,
    traces,
    steered,
    setSnapshot: (snapshot) => {
      current = snapshot;
    },
  };
}

function statusBlocks(messages: readonly AnnotatableMessage[]): string[] {
  const text = messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
            .join('\n'),
    )
    .join('\n');
  return text.match(/<environment_status>[\s\S]*?<\/environment_status>/g) ?? [];
}

describe('parallel tool batches', () => {
  it('exposes one coherent status per boundary regardless of batch size', async () => {
    const setup = harness('cancel-ambient');

    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);

    // Three siblings from one assistant message, settling in a different order than
    // they were issued. The trigger becomes true partway through the batch.
    setup.engine.observeTool({
      toolCallId: 'c',
      toolName: 'bash',
      input: { command: 'ls' },
      outputText: 'src',
      isError: false,
      batchId: 'turn-0',
      siblingOrdinal: 2,
    });
    setup.engine.observeTool({
      toolCallId: 'a',
      toolName: 'edit',
      input: { path: 'src/a.ts' },
      outputText: 'ok',
      isError: false,
      batchId: 'turn-0',
      siblingOrdinal: 0,
    });
    setup.setSnapshot(snap('changed', true));
    setup.engine.observeTool({
      toolCallId: 'b',
      toolName: 'read',
      input: { path: 'src/a.ts' },
      outputText: 'contents',
      isError: false,
      batchId: 'turn-0',
      siblingOrdinal: 1,
    });

    // Nothing may be exposed while the batch is in flight.
    expect(
      setup.traces.filter((event) => event.type === 'environment_exposure'),
    ).toHaveLength(0);

    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['edit', 'read', 'bash'],
    });

    const messages = setup.engine.decisionBoundary<AnnotatableMessage>([
      { role: 'user', content: 'Begin.' },
      { role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] },
      {
        role: 'toolResult',
        toolCallId: 'b',
        content: [{ type: 'text', text: 'contents' }],
      },
      { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'src' }] },
    ]);

    const blocks = statusBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('unread="1"');
    // The one status block sits on the last observation of the batch.
    const boundary = setup.traces.find(
      (event) => event.type === 'decision_boundary' && event.seq > 0,
    );
    expect(boundary?.type === 'decision_boundary' && boundary.statusAnchor).toBe('tool:c');
  });
});

describe('indicator persistence', () => {
  it('keeps showing the unread counter at every boundary until Slack is read', async () => {
    const setup = harness('cancel-ambient');
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    setup.engine.observeTool({
      toolCallId: 'e0',
      toolName: 'edit',
      input: { path: 'src/a.ts' },
      outputText: 'ok',
      isError: false,
    });
    setup.setSnapshot(snap('changed', true));
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['edit'],
    });

    // Three consecutive boundaries with no Slack read: the badge must persist.
    for (let turn = 1; turn <= 3; turn += 1) {
      const messages = setup.engine.decisionBoundary<AnnotatableMessage>([
        { role: 'user', content: 'Begin.' },
        {
          role: 'toolResult',
          toolCallId: 'e' + turn,
          content: [{ type: 'text', text: 'ok' }],
        },
      ]);
      const blocks = statusBlocks(messages);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('unread="1"');
      expect(blocks[0]).toContain('mentions="1"');
      setup.engine.observeTool({
        toolCallId: 'e' + (turn + 1),
        toolName: 'edit',
        input: { path: 'src/a.ts' },
        outputText: 'ok',
        isError: false,
      });
      await setup.engine.settleTurn({
        assistantText: '',
        stopReason: 'toolUse',
        toolCallNames: ['edit'],
      });
    }

    // The indicator is only ever *recorded* as exposed once.
    expect(
      setup.traces.filter(
        (event) =>
          event.type === 'environment_exposure' && event.exposureKind === 'indicator',
      ),
    ).toHaveLength(1);

    // Reading clears it.
    const read = setup.slack.readUnread();
    const action = setup.engine.observeTool({
      toolCallId: 'r1',
      toolName: 'read_slack_messages',
      input: {},
      outputText: JSON.stringify(read),
      isError: false,
    });
    setup.engine.observeSlackRead(
      action,
      read.map((message) => message.id),
      setup.slack.readCursor,
    );
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['read_slack_messages'],
    });
    const after = setup.engine.decisionBoundary<AnnotatableMessage>([
      { role: 'user', content: 'Begin.' },
      { role: 'toolResult', toolCallId: 'r1', content: [{ type: 'text', text: 'read' }] },
    ]);
    expect(statusBlocks(after)[0]).toContain('unread="0"');
  });
});

describe('exposed delivery', () => {
  it('places the full message once, keeps it anchored, and needs no Slack read', async () => {
    const setup = harness('cancel-exposed');
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    setup.engine.observeTool({
      toolCallId: 'a',
      toolName: 'edit',
      input: { path: 'src/a.ts' },
      outputText: 'ok',
      isError: false,
    });
    setup.setSnapshot(snap('changed', true));
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['edit'],
    });

    const context = (): AnnotatableMessage[] => [
      { role: 'user', content: 'Begin.' },
      { role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] },
      { role: 'toolResult', toolCallId: 'b', content: [{ type: 'text', text: 'more' }] },
    ];

    const first = setup.engine.decisionBoundary<AnnotatableMessage>(context());
    const firstText = JSON.stringify(first);
    expect(firstText).toContain('environment_event');
    expect(firstText).toContain('Priya is handling it now');
    expect(firstText.match(/<environment_event>/g)).toHaveLength(1);

    // Re-applied at the same anchor on the next call, still exactly once.
    const second = setup.engine.decisionBoundary<AnnotatableMessage>(context());
    expect(JSON.stringify(second).match(/<environment_event>/g)).toHaveLength(1);

    const exposures = setup.traces.filter(
      (event) => event.type === 'environment_exposure' && event.exposureKind === 'content',
    );
    expect(exposures).toHaveLength(1);
    // Content arrived without any read_slack_messages call.
    expect(setup.traces.some((event) => event.type === 'slack_read')).toBe(false);
  });
});

describe('steer delivery', () => {
  it('hands the identical text to the runtime channel and clears the unread badge', async () => {
    const setup = harness('cancel-steer');
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    setup.engine.observeTool({
      toolCallId: 'a',
      toolName: 'edit',
      input: { path: 'src/a.ts' },
      outputText: 'ok',
      isError: false,
    });
    setup.setSnapshot(snap('changed', true));
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['edit'],
    });

    expect(setup.steered).toEqual([CANCELLATION_TEXT]);

    const messages = setup.engine.decisionBoundary<AnnotatableMessage>([
      { role: 'user', content: 'Begin.' },
      { role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: CANCELLATION_TEXT },
    ]);
    // Already delivered through steering, so it is not also left unread.
    expect(statusBlocks(messages)[0]).toContain('unread="0"');
    const exposures = setup.traces.filter(
      (event) => event.type === 'environment_exposure' && event.exposureKind === 'steer',
    );
    expect(exposures).toHaveLength(1);
  });

  it('delivers the same authoritative text in all three cancellation conditions', () => {
    for (const id of [
      'cancel-ambient',
      'cancel-exposed',
      'cancel-steer',
      'cancel-ambient-late',
    ]) {
      expect(getScenario(id).payload?.text).toBe(CANCELLATION_TEXT);
    }
  });
});

describe('workspace confinement', () => {
  const options = {
    workspacePath: '/tmp/run/workspace',
    fixturePath: '/home/user/fixture',
    resultsDir: '/home/user/eval/results',
  };

  it('treats a directory as inside itself but not its parent', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
  });

  it('allows in-workspace paths and blocks escapes for every file tool', () => {
    for (const tool of ['read', 'edit', 'write', 'grep', 'find', 'ls']) {
      expect(guardToolCall(tool, { path: 'src/a.ts' }, options).block).toBe(false);
      expect(guardToolCall(tool, { path: '../../etc/passwd' }, options).block).toBe(true);
      expect(guardToolCall(tool, { path: '/etc/passwd' }, options).rule).toBe(
        'workspace_escape',
      );
    }
  });

  it('protects the pinned fixture and the results directory', () => {
    expect(
      guardToolCall('read', { path: options.fixturePath + '/src/a.ts' }, options).rule,
    ).toBe('fixture_integrity');
    expect(
      guardToolCall('write', { path: options.resultsDir + '/trace.jsonl' }, options).rule,
    ).toBe('results_integrity');
    expect(
      guardToolCall(
        'bash',
        { command: 'cat ' + options.fixturePath + '/package.json' },
        options,
      ).rule,
    ).toBe('fixture_integrity');
    expect(
      guardToolCall('bash', { command: 'grep -r x ' + options.resultsDir }, options).rule,
    ).toBe('results_integrity');
  });

  it('does not interfere with ordinary in-workspace shell work', () => {
    for (const command of [
      'pnpm test',
      'git commit -m fix',
      'git diff',
      'node --run typecheck',
    ]) {
      expect(guardToolCall('bash', { command }, options).block).toBe(false);
    }
  });
});

describe('reasoning passthrough at turn settlement', () => {
  it('records reasoning on the assistant_turn event when the adapter supplied it', async () => {
    const setup = harness('baseline');
    await setup.engine.settleTurn({
      assistantText: '',
      reasoningText: 'An unread mention arrived; read it before editing further.',
      reasoningTokens: 256,
      stopReason: 'toolUse',
      toolCallNames: ['read'],
    });

    const turn = setup.traces.find((event) => event.type === 'assistant_turn');
    expect(turn).toMatchObject({
      reasoningText: 'An unread mention arrived; read it before editing further.',
      reasoningTokens: 256,
    });
  });

  it('omits the fields entirely when the provider returned no reasoning', async () => {
    // Emitting `reasoningText: ''` here would make a provider that withholds reasoning
    // indistinguishable from a model that reasoned about nothing.
    const setup = harness('baseline');
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['read'],
    });

    const turn = setup.traces.find((event) => event.type === 'assistant_turn');
    expect(turn).toBeDefined();
    expect(turn).not.toHaveProperty('reasoningText');
    expect(turn).not.toHaveProperty('reasoningTokens');
    expect(turn).not.toHaveProperty('reasoningRedacted');
  });

  it('carries the redaction flag for a turn whose reasoning was filtered', async () => {
    const setup = harness('baseline');
    await setup.engine.settleTurn({
      assistantText: '',
      reasoningText: '',
      reasoningRedacted: true,
      stopReason: 'toolUse',
      toolCallNames: ['read'],
    });

    const turn = setup.traces.find((event) => event.type === 'assistant_turn');
    expect(turn).toMatchObject({ reasoningText: '', reasoningRedacted: true });
  });

  it('bounds long reasoning the way it bounds every other persisted text', async () => {
    const setup = harness('baseline');
    await setup.engine.settleTurn({
      assistantText: '',
      reasoningText: 'x'.repeat(20_000),
      stopReason: 'toolUse',
      toolCallNames: ['read'],
    });

    const turn = setup.traces.find((event) => event.type === 'assistant_turn');
    const recorded =
      turn !== undefined && 'reasoningText' in turn ? (turn.reasoningText ?? '') : '';
    expect(recorded.length).toBeLessThan(20_000);
    expect(recorded).toContain('omitted by the trace writer');
  });
});
