import { describe, it, expect } from 'vitest';
import { parseBatch, claudeArgs, nativeDecisionsOverlap } from '../src/claude/adapter.js';

describe('Claude controlled bridge', () => {
  it('rejects an entire oversized batch before any sibling can execute', () => {
    expect(() =>
      parseBatch(
        {
          actions: [
            { name: 'write', input: { path: 'a' } },
            { name: 'bash', input: { command: 'git commit' } },
          ],
        },
        ['write', 'bash'],
        1,
      ),
    ).toThrow('remaining action budget');
  });
  it('rejects unknown and malformed actions instead of silently dropping them', () => {
    expect(() =>
      parseBatch(
        {
          actions: [
            { name: 'read', input: {} },
            { name: 'native_bash', input: {} },
          ],
        },
        ['read'],
        120,
      ),
    ).toThrow('unknown tool');
    expect(() => parseBatch({ actions: [] }, ['read'], 120)).toThrow();
    expect(() =>
      parseBatch({ actions: [{ name: 'read', input: 'bad' }] }, ['read'], 120),
    ).toThrow();
  });
  it('retains sibling order and exact argument content', () => {
    const input = {
      actions: [
        { name: 'edit', input: { path: 'src/a', oldText: 'old', newText: 'new' } },
        { name: 'bash', input: { command: 'pnpm test' } },
      ],
    };
    expect(parseBatch(input, ['edit', 'bash'], 2)).toEqual(input.actions);
  });
  it('uses the exact model and effort, disables native tools, and confines MCP config', () => {
    const args = claudeArgs('claude-opus-5', 'high', 'system', 'http://127.0.0.1:123/test');
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value('--model')).toBe('claude-opus-5');
    expect(value('--effort')).toBe('high');
    expect(value('--tools')).toBe('');
    expect(value('--system-prompt')).toBe('system');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--include-partial-messages');
    expect(args).not.toContain('--fallback-model');
    expect(JSON.parse(value('--mcp-config')!).mcpServers.eval.url).toBe(
      'http://127.0.0.1:123/test',
    );
  });
});

import {
  NativeTurnAssembler,
  BatchBarrier,
  SiblingCollector,
} from '../src/claude/protocol.js';
import { ExperimentEngine, SlackState } from '../src/engine/experiment.js';
import { getScenario } from '../src/scenarios/catalog.js';
import type { WorkspaceSnapshot } from '../src/workspace/snapshot.js';

it('assembles text and tool blocks into one complete native model decision', () => {
  const assembler = new NativeTurnAssembler();
  expect(
    assembler.accept({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Inspecting' }] },
    }),
  ).toBeUndefined();
  expect(
    assembler.accept({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'a', name: 'mcp__eval__execute_batch' }],
      },
    }),
  ).toBeUndefined();
  expect(
    assembler.accept({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    }),
  ).toBeUndefined();
  const turn = assembler.accept({ type: 'stream_event', event: { type: 'message_stop' } })!;
  expect(turn.blocks).toHaveLength(2);
  expect(turn.stopReason).toBe('tool_use');
  expect(
    assembler.accept({ type: 'stream_event', event: { type: 'message_stop' } })?.blocks,
  ).toEqual([]);
});
it('passes a malformed (__unparsedToolInput) tool block through for the caller to drop', () => {
  const assembler = new NativeTurnAssembler();
  assembler.accept({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'x',
          name: 'mcp__eval__edit',
          input: { __unparsedToolInput: { raw: '{"path":', len: 8 } },
        },
      ],
    },
  });
  assembler.accept({
    type: 'stream_event',
    event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  });
  const turn = assembler.accept({ type: 'stream_event', event: { type: 'message_stop' } })!;
  const call = turn.blocks.find((b) => b.type === 'tool_use')!;
  expect(
    call.input && typeof call.input === 'object' && '__unparsedToolInput' in call.input,
  ).toBe(true);
});
it('collects multiple sibling MCP calls only after seeing the complete message', () => {
  const assembler = new NativeTurnAssembler();
  for (const id of ['a', 'b'])
    assembler.accept({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'mcp__eval__execute_batch' }] },
    });
  expect(
    assembler.accept({ type: 'stream_event', event: { type: 'message_stop' } })?.blocks,
  ).toHaveLength(2);
});
it('holds early MCP dispatch until message_stop and aborts a missing boundary', async () => {
  const barrier = new BatchBarrier();
  const controller = new AbortController();
  let executed = false;
  const request = barrier.wait(controller.signal).then(() => {
    executed = true;
  });
  await Promise.resolve();
  expect(executed).toBe(false);
  barrier.publish();
  await request;
  expect(executed).toBe(true);
  barrier.reset();
  const waiting = barrier.wait(controller.signal);
  controller.abort();
  await expect(waiting).rejects.toThrow('aborted');
});
it('exposes ambient counters only after every action settles, without cancellation content', async () => {
  const slack = new SlackState();
  let mutated = false;
  const engine = new ExperimentEngine({
    scenario: getScenario('cancel-ambient'),
    slack,
    sink: () => {},
    steer: async () => {},
    limits: { maxTurns: 40, maxActions: 120 },
    snapshot: async () =>
      ({
        headCommit: 'a'.repeat(40),
        commitsAheadOfFixture: 0,
        sourceMutated: mutated,
        workingTreeDirty: mutated,
        statusPorcelain: ' M src/a',
        trackedSourceDigest: mutated ? 'after' : 'before',
        commits: [],
        changedWatchedFiles: ['src/a'],
        untrackedWatchedFiles: [],
        changedFiles: ['src/a'],
        untrackedFiles: [],
      }) as WorkspaceSnapshot,
  });
  engine.decisionBoundary([{ role: 'user', content: 'ticket' }]);
  engine.observeTool({
    toolCallId: 'a',
    toolName: 'write',
    input: { path: 'src/a' },
    outputText: 'ok',
    isError: false,
  });
  mutated = true;
  expect(engine.state.eventCreated).toBeUndefined();
  engine.observeTool({
    toolCallId: 'b',
    toolName: 'read',
    input: { path: 'src/a' },
    outputText: 'code',
    isError: false,
  });
  expect(engine.state.eventCreated).toBeUndefined();
  await engine.settleTurn({
    assistantText: '',
    stopReason: 'toolUse',
    toolCallNames: ['write', 'read'],
  });
  const next = engine.decisionBoundary([
    { role: 'toolResult', toolCallId: 'batch', content: 'results' },
  ]);
  expect(next[0]?.content).toContain('unread="1"');
  expect(next[0]?.content).not.toContain(engine.state.eventCreated!.text);
  expect(engine.state.ambientLeakDetected).toBe(false);
  expect(engine.state.turns[0]?.actionIndices).toHaveLength(2);
});

it('collects out-of-order HTTP siblings in native order, including duplicate arguments', () => {
  const collector = new SiblingCollector<number>([
    { id: 'first', input: { a: 1, b: 2 } },
    { id: 'second', input: { x: 3 } },
    { id: 'third', input: { a: 1, b: 2 } },
  ]);
  expect(collector.add({ x: 3 }, 20)).toBe(false);
  expect(collector.add({ b: 2, a: 1 }, 10)).toBe(false);
  expect(collector.add({ a: 1, b: 2 }, 30)).toBe(true);
  expect(collector.calls.map((c) => collector.received.get(c.id))).toEqual([10, 20, 30]);
  expect(() => collector.add({ x: 3 }, 40)).toThrow('unclaimed');
});

it('binds a sibling by its native tool_use id when the arguments are identical', () => {
  const collector = new SiblingCollector<number>([
    { id: 'a', input: { actions: [{ name: 'read', input: { path: 'p' } }] } },
    { id: 'b', input: { actions: [{ name: 'read', input: { path: 'p' } }] } },
  ]);
  // Same args for both; only the id disambiguates which native block this request answers.
  expect(collector.add({ actions: [{ name: 'read', input: { path: 'p' } }] }, 2, 'b')).toBe(
    false,
  );
  expect(collector.add({ actions: [{ name: 'read', input: { path: 'p' } }] }, 1, 'a')).toBe(
    true,
  );
  expect(collector.calls.map((c) => collector.received.get(c.id))).toEqual([1, 2]);
});

it('rejects a redelivered tool_use id rather than double-claiming a native block', () => {
  const collector = new SiblingCollector<number>([
    { id: 'a', input: { actions: [{ name: 'bash', input: { command: 'ls' } }] } },
  ]);
  expect(
    collector.add({ actions: [{ name: 'bash', input: { command: 'ls' } }] }, 1, 'a'),
  ).toBe(true);
  expect(() =>
    collector.add({ actions: [{ name: 'bash', input: { command: 'ls' } }] }, 9, 'a'),
  ).toThrow('redelivers');
});

it('treats a settled batch with lagging sibling requests as non-overlapping', () => {
  // Two siblings executed sequentially: the first HTTP request runs the whole batch and
  // caches every result; the second arrives later and is served from cache without ever
  // touching the collector. The next native message must not read that as an overlap.
  const collector = new SiblingCollector<number>([
    { id: 'a', input: { actions: [{ name: 'ls', input: {} }] } },
    { id: 'b', input: { actions: [{ name: 'grep', input: { pattern: 'x' } }] } },
  ]);
  collector.add({ actions: [{ name: 'ls', input: {} }] }, 1, 'a');
  // batch runs for BOTH declared calls, then settles; 'b' is served from servedResults.
  const pending = { started: true, settled: true, collector };
  expect(collector.received.size).not.toBe(collector.calls.length); // bookkeeping is intentionally incomplete
  expect(nativeDecisionsOverlap(pending, false)).toBe(false);
  // A batch still executing IS an overlap.
  expect(nativeDecisionsOverlap({ started: true, settled: false }, false)).toBe(true);
  expect(nativeDecisionsOverlap(undefined, true)).toBe(true);
  expect(nativeDecisionsOverlap(undefined, false)).toBe(false);
});

it("re-arms the barrier each turn so a later early dispatch waits for that turn's message_stop", async () => {
  const barrier = new BatchBarrier();
  const controller = new AbortController();
  barrier.publish();
  await barrier.wait(controller.signal); // turn 1 settled
  barrier.reset(); // turn 2 message_start
  let released = false;
  const turn2 = barrier.wait(controller.signal).then(() => {
    released = true;
  });
  await Promise.resolve();
  expect(released).toBe(false); // held despite turn 1's publish
  barrier.publish();
  await turn2;
  expect(released).toBe(true);
});
