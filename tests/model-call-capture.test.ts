/**
 * The captured model context must record what the model actually received and returned.
 *
 * The trace alone cannot answer that: `inputSummary` reduces a `write` to a byte count and
 * an `edit` to an edit count, tool output is capped at 1500 characters, and nothing records
 * the message array at all. These tests pin the parts a reader would otherwise have to
 * reconstruct and could not verify.
 */

import { describe, expect, it } from 'vitest';

import {
  ExperimentEngine,
  SlackState,
  type CaptureRecord,
} from '../src/engine/experiment.js';
import type { AnnotatableMessage } from '../src/engine/environment.js';
import { getScenario } from '../src/scenarios/catalog.js';
import {
  MAX_ARGUMENT_TEXT,
  MAX_MESSAGE_TEXT,
  modelCallRecordSchema,
  MODEL_CALL_SCHEMA_VERSION,
} from '../src/trace/model-call.js';
import type { WorkspaceSnapshot } from '../src/workspace/snapshot.js';

function snap(mutated: boolean): WorkspaceSnapshot {
  return {
    headCommit: 'a'.repeat(40),
    commitsAheadOfFixture: 0,
    commits: [],
    sourceMutated: mutated,
    workingTreeDirty: mutated,
    statusPorcelain: '',
    trackedSourceDigest: mutated ? 'changed' : 'base',
    changedWatchedFiles: [],
    untrackedWatchedFiles: [],
    changedFiles: [],
    untrackedFiles: [],
  };
}

function harness(scenarioId = 'cancel-ambient') {
  const slack = new SlackState();
  slack.post({
    sender: 'Maya',
    senderRole: 'ticket_owner',
    text: 'ticket',
    mentionsAgent: true,
    logicalTime: -1,
  });
  const captured: CaptureRecord[] = [];
  const engine = new ExperimentEngine({
    scenario: getScenario(scenarioId),
    slack,
    sink: () => {},
    captureSink: (record) => captured.push(record),
    snapshot: async () => snap(false),
    steer: async () => {},
    limits: { maxTurns: 40, maxActions: 120 },
    now: () => new Date('2024-01-01T00:00:00.000Z'),
  });
  return { engine, captured };
}

const inputs = (records: CaptureRecord[]) =>
  records.filter((r): r is Extract<CaptureRecord, { type: 'call_input' }> =>
    r.type === 'call_input',
  );
const outputs = (records: CaptureRecord[]) =>
  records.filter((r): r is Extract<CaptureRecord, { type: 'call_output' }> =>
    r.type === 'call_output',
  );

describe('captured input', () => {
  it('records the context after annotation, not before', () => {
    const setup = harness();
    setup.engine.decisionBoundary<AnnotatableMessage>([
      { role: 'user', content: 'Fix TICKET-14.' },
    ]);

    const [input] = inputs(setup.captured);
    expect(input).toBeDefined();
    // The status block the harness appends must be present in the captured text: this is
    // the whole point of capturing at this seam rather than before annotation.
    expect(input!.capturedModelContext[0]!.text).toContain('<environment_status>');
    expect(input!.capturedModelContext[0]!.text).toContain('Fix TICKET-14.');
  });

  it('agrees with the message count the trace records for the same decision', async () => {
    const setup = harness();
    const messages: AnnotatableMessage[] = [{ role: 'user', content: 'Begin.' }];
    setup.engine.decisionBoundary(messages);
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: [],
    });
    setup.engine.decisionBoundary([
      ...messages,
      { role: 'assistant', content: '' },
      { role: 'toolResult', toolCallId: 't1', content: 'ok' },
    ]);

    const captured = inputs(setup.captured);
    expect(captured.map((record) => record.messageCount)).toEqual([1, 3]);
    expect(captured.map((record) => record.capturedModelContext.length)).toEqual([1, 3]);
  });

  it('keeps the tool call id that statusAnchor refers to', () => {
    const setup = harness();
    setup.engine.decisionBoundary<AnnotatableMessage>([
      { role: 'user', content: 'Begin.' },
      { role: 'toolResult', toolCallId: 'call-7', content: 'output' },
    ]);
    const [input] = inputs(setup.captured);
    expect(input!.capturedModelContext[1]!.toolCallId).toBe('call-7');
  });

  it('bounds a huge message and says so rather than cutting silently', () => {
    const setup = harness();
    const huge = 'x'.repeat(MAX_MESSAGE_TEXT + 500);
    setup.engine.decisionBoundary<AnnotatableMessage>([{ role: 'user', content: huge }]);
    const message = inputs(setup.captured)[0]!.capturedModelContext[0]!;
    expect(message.truncated).toBe(true);
    expect(message.chars).toBeGreaterThan(MAX_MESSAGE_TEXT);
    expect(message.text.length).toBe(MAX_MESSAGE_TEXT);
  });
});

describe('captured output', () => {
  it('records full tool-call arguments, which the trace deliberately does not', async () => {
    const setup = harness();
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    const body = 'export const answer = 42;\n'.repeat(40);
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['write'],
      toolCalls: [
        {
          id: 'w1',
          name: 'write',
          arguments: { path: 'src/answer.ts', content: body },
        },
      ],
    });

    const [output] = outputs(setup.captured);
    // `summarizeToolInput` would have kept only `contentBytes` here.
    expect(output!.toolCalls[0]!.arguments['content']).toBe(body);
    expect(output!.toolCalls[0]!.arguments['path']).toBe('src/answer.ts');
    expect(output!.toolCalls[0]!.truncatedArguments).toEqual([]);
  });

  it('names the arguments it had to cut', async () => {
    const setup = harness();
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['write'],
      toolCalls: [
        {
          id: 'w1',
          name: 'write',
          arguments: { path: 'src/a.ts', content: 'y'.repeat(MAX_ARGUMENT_TEXT + 1) },
        },
      ],
    });
    const call = outputs(setup.captured)[0]!.toolCalls[0]!;
    expect(call.truncatedArguments).toEqual(['content']);
    expect(call.arguments['path']).toBe('src/a.ts');
  });

  it('leaves non-string arguments structurally intact', async () => {
    const setup = harness();
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['edit'],
      toolCalls: [
        {
          id: 'e1',
          name: 'edit',
          arguments: { path: 'src/a.ts', edits: [{ old: 'a', new: 'b' }], count: 1 },
        },
      ],
    });
    const call = outputs(setup.captured)[0]!.toolCalls[0]!;
    expect(call.arguments['edits']).toEqual([{ old: 'a', new: 'b' }]);
    expect(call.arguments['count']).toBe(1);
  });

  it('records reasoning and usage when the provider returned them', async () => {
    const setup = harness();
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    await setup.engine.settleTurn({
      assistantText: 'done',
      reasoningText: 'the cancellation makes the commit pointless',
      stopReason: 'stop',
      toolCallNames: [],
      usage: { input: 1200, output: 40, reasoning: 310 },
    });
    const [output] = outputs(setup.captured);
    expect(output!.reasoningText).toContain('cancellation');
    expect(output!.usage).toEqual({ input: 1200, output: 40, reasoning: 310 });
  });

  it('pairs every output with the decision whose input it answers', async () => {
    const setup = harness();
    for (let index = 0; index < 3; index += 1) {
      setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
      await setup.engine.settleTurn({
        assistantText: '',
        stopReason: 'toolUse',
        toolCallNames: [],
      });
    }
    expect(inputs(setup.captured).map((r) => r.decisionIndex)).toEqual([0, 1, 2]);
    expect(outputs(setup.captured).map((r) => r.decisionIndex)).toEqual([0, 1, 2]);
  });
});

describe('capture is never load-bearing', () => {
  it('does not fail a run when the sink throws', async () => {
    const slack = new SlackState();
    const engine = new ExperimentEngine({
      scenario: getScenario('cancel-ambient'),
      slack,
      sink: () => {},
      captureSink: () => {
        throw new Error('disk full');
      },
      snapshot: async () => snap(false),
      steer: async () => {},
      limits: { maxTurns: 40, maxActions: 120 },
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });

    expect(() => engine.decisionBoundary([{ role: 'user', content: 'Begin.' }])).not.toThrow();
    await expect(
      engine.settleTurn({ assistantText: '', stopReason: 'stop', toolCallNames: [] }),
    ).resolves.toBeUndefined();
  });

  it('is inert when no sink is configured', () => {
    const engine = new ExperimentEngine({
      scenario: getScenario('cancel-ambient'),
      slack: new SlackState(),
      sink: () => {},
      snapshot: async () => snap(false),
      steer: async () => {},
      limits: { maxTurns: 40, maxActions: 120 },
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });
    expect(() => engine.decisionBoundary([{ role: 'user', content: 'Begin.' }])).not.toThrow();
  });
});

describe('records validate against their schema', () => {
  it('accepts what the engine actually produces', async () => {
    const setup = harness();
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    await setup.engine.settleTurn({
      assistantText: 'done',
      stopReason: 'stop',
      toolCallNames: ['bash'],
      toolCalls: [{ id: 'b1', name: 'bash', arguments: { command: 'pnpm test' } }],
    });

    for (const record of setup.captured) {
      const parsed = modelCallRecordSchema.safeParse({
        ...record,
        schemaVersion: MODEL_CALL_SCHEMA_VERSION,
      });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('ModelCallWriter', () => {
  it('writes one valid JSON record per line and survives a mid-run stop', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const nodePath = await import('node:path');
    const { ModelCallWriter } = await import('../src/trace/writer.js');

    const dir = await mkdtemp(nodePath.join(tmpdir(), 'eaw-capture-'));
    const writer = await ModelCallWriter.create(dir);

    writer.append({
      type: 'call_input',
      decisionIndex: 0,
      wallClockIso: '2024-01-01T00:00:00.000Z',
      capturedModelContext: [
        { role: 'user', text: 'Begin.', truncated: false, chars: 6 },
      ],
      messageCount: 1,
    });
    writer.append({
      type: 'call_output',
      decisionIndex: 0,
      turnIndex: 0,
      wallClockIso: '2024-01-01T00:00:01.000Z',
      text: '',
      stopReason: 'toolUse',
      toolCalls: [
        { id: 'b1', name: 'bash', arguments: { command: 'ls' }, truncatedArguments: [] },
      ],
    });

    // Appended synchronously, so a run killed here still leaves both records readable.
    const raw = await readFile(nodePath.join(dir, 'context.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(modelCallRecordSchema.safeParse(JSON.parse(line)).success).toBe(true);
    }
    expect(writer.count).toBe(2);
  });

  it('refuses a record that does not match the schema', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const nodePath = await import('node:path');
    const { ModelCallWriter } = await import('../src/trace/writer.js');

    const dir = await mkdtemp(nodePath.join(tmpdir(), 'eaw-capture-'));
    const writer = await ModelCallWriter.create(dir);
    expect(() =>
      writer.append({
        type: 'call_input',
        decisionIndex: 0,
        wallClockIso: '2024-01-01T00:00:00.000Z',
        capturedModelContext: [
          { role: 'user', text: 'x', truncated: false } as never,
        ],
        messageCount: 1,
      }),
    ).toThrow();
  });
});
