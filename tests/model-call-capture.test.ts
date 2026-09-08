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
  captureMessage,
  MAX_ARGUMENT_DEPTH,
  MAX_ARGUMENT_TEXT,
  MAX_MESSAGE_TEXT,
  modelCallRecordSchema,
  MODEL_CALL_SCHEMA_VERSION,
} from '../src/trace/model-call.js';
import { isSensitiveKey } from '../src/trace/redact.js';
import { readEffectiveSystemPrompt } from '../src/pi/adapter.js';
import { buildCaptureAudit } from '../src/runner.js';
import type { TraceEvent } from '../src/trace/schema.js';
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
  records.filter(
    (r): r is Extract<CaptureRecord, { type: 'call_input' }> => r.type === 'call_input',
  );
const outputs = (records: CaptureRecord[]) =>
  records.filter(
    (r): r is Extract<CaptureRecord, { type: 'call_output' }> => r.type === 'call_output',
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

    expect(() =>
      engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]),
    ).not.toThrow();
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
    expect(() =>
      engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]),
    ).not.toThrow();
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
      capturedModelContext: [{ role: 'user', text: 'Begin.', truncated: false, chars: 6 }],
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
        capturedModelContext: [{ role: 'user', text: 'x', truncated: false } as never],
        messageCount: 1,
      }),
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* v2: structured blocks                                                       */
/* -------------------------------------------------------------------------- */

describe('structured message blocks', () => {
  it('preserves thinking and tool calls that the v1 text-only capture deleted', () => {
    const setup = harness();
    setup.engine.decisionBoundary<AnnotatableMessage>([
      { role: 'user', content: 'Begin.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'the ticket says fix the refund path' },
          { type: 'text', text: 'Reading the ledger store.' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'read',
            arguments: { path: 'src/ledger-store.ts' },
          },
        ],
      },
    ]);

    const assistant = inputs(setup.captured)[0]!.capturedModelContext[1]!;
    expect(assistant.blocks?.map((block) => block.kind)).toEqual([
      'thinking',
      'text',
      'toolCall',
    ]);

    const thinking = assistant.blocks![0]!;
    expect(thinking.kind === 'thinking' && thinking.text).toBe(
      'the ticket says fix the refund path',
    );
    const call = assistant.blocks![2]!;
    expect(call.kind === 'toolCall' && call.name).toBe('read');
    expect(call.kind === 'toolCall' && call.arguments['path']).toBe('src/ledger-store.ts');

    // The v1 field keeps its exact old meaning: the text parts, and only the text parts.
    expect(assistant.text).toBe('Reading the ledger store.');
  });

  it('marks a provider-redacted thinking block as such, distinctly from secret scrubbing', () => {
    const captured = captureMessage({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '', redacted: true }],
    });
    const block = captured.blocks![0]!;
    expect(block.kind).toBe('thinking');
    expect(block.kind === 'thinking' && block.providerRedacted).toBe(true);
    // The harness's own scrub did nothing here; conflating the two would hide which
    // party removed the text.
    expect(block.kind === 'thinking' && block.redacted).toBe(false);
  });

  it('describes an image rather than inlining megabytes of base64, and says so', () => {
    const captured = captureMessage({
      role: 'toolResult',
      toolCallId: 't1',
      content: [
        { type: 'text', text: 'screenshot attached' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(5_000) },
      ],
    });
    const image = captured.blocks![1]!;
    expect(image.kind).toBe('image');
    expect(image.kind === 'image' && image.dataChars).toBe(5_000);
    expect(image.kind === 'image' && image.payloadOmitted).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('A'.repeat(100));
    // Omission is not truncation: the text in this message was complete.
    expect(captured.omitted).toBe(true);
    expect(captured.truncated).toBe(false);
  });

  it('records an unrecognised block type by name and shape instead of dropping it', () => {
    const captured = captureMessage({
      role: 'assistant',
      content: [{ type: 'futureBlock', payload: 'x', handle: 'y' }],
    });
    const block = captured.blocks![0]!;
    expect(block.kind).toBe('unsupported');
    expect(block.kind === 'unsupported' && block.blockType).toBe('futureBlock');
    expect(block.kind === 'unsupported' && block.keys).toEqual([
      'handle',
      'payload',
      'type',
    ]);
    expect(captured.omitted).toBe(true);
  });

  it('keeps the tool result identity a reader needs to pair it with its call', () => {
    const captured = captureMessage({
      role: 'toolResult',
      toolCallId: 'call-9',
      toolName: 'bash',
      isError: true,
      content: [{ type: 'text', text: 'command not found' }],
    });
    expect(captured.toolCallId).toBe('call-9');
    expect(captured.toolName).toBe('bash');
    expect(captured.isError).toBe(true);
  });

  it('turns a plain string content into one text block, so blocks is always the record', () => {
    const captured = captureMessage({ role: 'user', content: 'Fix TICKET-14.' });
    expect(captured.blocks).toHaveLength(1);
    expect(captured.blocks![0]!.kind).toBe('text');
    expect(captured.text).toBe('Fix TICKET-14.');
  });
});

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

describe('redaction', () => {
  it('scrubs a secret out of captured message text and flags that it did', () => {
    const setup = harness();
    setup.engine.decisionBoundary<AnnotatableMessage>([
      { role: 'user', content: 'use sk-abcdefghijklmnop1234 to authenticate' },
    ]);
    const message = inputs(setup.captured)[0]!.capturedModelContext[0]!;
    expect(message.text).not.toContain('sk-abcdefghijklmnop1234');
    expect(message.text).toContain('[REDACTED]');
    expect(message.redacted).toBe(true);
  });

  it('redacts a nested argument value by its key, which no pattern over the value would catch', async () => {
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
          arguments: {
            path: 'config.json',
            config: {
              database: { host: 'localhost', password: 'hunter2' },
              tokens: ['opaque-value-one', 'opaque-value-two'],
            },
          },
        },
      ],
    });

    const call = outputs(setup.captured)[0]!.toolCalls[0]!;
    const config = call.arguments['config'] as {
      database: { host: string; password: string };
      tokens: string[];
    };
    // Neither of these strings matches any value pattern; the key is what makes them
    // secret, and v1 walked only the top level so both went through untouched.
    expect(config.database.password).toBe('[REDACTED]');
    expect(config.tokens).toEqual(['[REDACTED]', '[REDACTED]']);
    // Non-sensitive neighbours survive, or the record would be useless.
    expect(config.database.host).toBe('localhost');
    expect(call.redacted).toBe(true);
  });

  it('normalizes key spelling so apiKey, api_key and API-KEY are one rule', () => {
    for (const key of [
      'apiKey',
      'api_key',
      'API-KEY',
      'apikey',
      'Password',
      'accessToken',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    // A plural key holds the same thing several times.
    for (const key of ['tokens', 'secrets', 'passwords']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['path', 'content', 'command', 'tokenizer', 'access']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('bounds a nested argument string, which v1 let through at any size', () => {
    const captured = captureMessage({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'e1',
          name: 'edit',
          arguments: { edits: [{ new: 'z'.repeat(MAX_ARGUMENT_TEXT + 10) }] },
        },
      ],
    });
    const block = captured.blocks![0]!;
    expect(block.kind === 'toolCall' && block.truncatedArguments).toEqual(['edits']);
    const edits =
      block.kind === 'toolCall' ? (block.arguments['edits'] as Array<{ new: string }>) : [];
    expect(edits[0]!.new.length).toBe(MAX_ARGUMENT_TEXT);
  });

  it('flags a depth-capped argument as an omission rather than passing off the note as the value', () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let level = 0; level < MAX_ARGUMENT_DEPTH + 3; level += 1) deep = { next: deep };
    const captured = captureMessage({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'x', name: 'write', arguments: { deep } }],
    });
    const block = captured.blocks![0]!;
    expect(block.kind === 'toolCall' && block.depthCapped).toBe(true);
    expect(captured.omitted).toBe(true);
    expect(JSON.stringify(captured)).toContain('nesting deeper than');
  });

  it('scrubs the assistant output and its reasoning on the same terms as the input', async () => {
    const setup = harness();
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    await setup.engine.settleTurn({
      assistantText: 'the key is sk-zyxwvutsrqponml9876',
      reasoningText: 'I will reuse sk-zyxwvutsrqponml9876 for the call',
      stopReason: 'stop',
      toolCallNames: [],
    });
    const output = outputs(setup.captured)[0]!;
    expect(output.text).not.toContain('sk-zyxwvutsrqponml9876');
    expect(output.reasoningText).not.toContain('sk-zyxwvutsrqponml9876');
  });
});

/* -------------------------------------------------------------------------- */
/* Capture completeness is diagnostic, never behavioural                       */
/* -------------------------------------------------------------------------- */

describe('capture accounting', () => {
  it('names the failures it absorbed instead of silently writing a short file', async () => {
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

    engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    await engine.settleTurn({ assistantText: '', stopReason: 'stop', toolCallNames: [] });

    const diagnostics = engine.captureDiagnostics;
    expect(diagnostics.failureCount).toBe(2);
    expect(diagnostics.failures.map((failure) => failure.stage)).toEqual([
      'call_input',
      'call_output',
    ]);
    expect(diagnostics.failures[0]!.message).toContain('disk full');
  });

  it('counts truncated, redacted and omitted messages separately', () => {
    const setup = harness();
    setup.engine.decisionBoundary<AnnotatableMessage>([
      { role: 'user', content: 'x'.repeat(MAX_MESSAGE_TEXT + 1) },
      { role: 'user', content: 'token: abcdefghijklmnop' },
      {
        role: 'assistant',
        content: [{ type: 'image', mimeType: 'image/png', data: 'AA' }],
      },
    ]);
    const diagnostics = setup.engine.captureDiagnostics;
    expect(diagnostics.truncatedMessageCount).toBe(1);
    expect(diagnostics.redactedMessageCount).toBe(1);
    expect(diagnostics.omittedBlockMessageCount).toBe(1);
    expect(diagnostics.failureCount).toBe(0);
  });

  it('produces an identical trace whether the capture sink works or throws', async () => {
    const drive = async (mode: 'working' | 'throwing'): Promise<TraceEvent[]> => {
      const events: TraceEvent[] = [];
      const engine = new ExperimentEngine({
        scenario: getScenario('cancel-ambient'),
        slack: new SlackState(),
        sink: (event) => events.push(event),
        captureSink:
          mode === 'throwing'
            ? () => {
                throw new Error('nope');
              }
            : () => {},
        snapshot: async () => snap(true),
        steer: async () => {},
        limits: { maxTurns: 40, maxActions: 120 },
        now: () => new Date('2024-01-01T00:00:00.000Z'),
      });
      for (let index = 0; index < 3; index += 1) {
        engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
        engine.observeTool({
          toolCallId: `t${index}`,
          toolName: 'bash',
          input: { command: 'pnpm test' },
          outputText: 'Tests  12 passed',
          isError: false,
        });
        await engine.settleTurn({
          assistantText: 'working',
          stopReason: 'toolUse',
          toolCallNames: ['bash'],
          toolCalls: [
            { id: `t${index}`, name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        });
      }
      return events;
    };

    // The trace is the sole input to grading. If it is byte-identical either way, no
    // capture failure can move a behavioural result, which is the invariant that lets the
    // capture absorb errors at all.
    expect(JSON.stringify(await drive('throwing'))).toEqual(
      JSON.stringify(await drive('working')),
    );
  });
});

describe('buildCaptureAudit', () => {
  const base = {
    contextPath: '/tmp/run/context.jsonl',
    engine: {
      failures: [],
      failureCount: 0,
      truncatedMessageCount: 0,
      redactedMessageCount: 0,
      omittedBlockMessageCount: 0,
    },
    runnerFailures: [],
    systemPromptSource: 'runtime_session' as const,
  };

  it('calls a run complete when every boundary has an input and nothing failed', () => {
    const audit = buildCaptureAudit({
      ...base,
      stats: { headerWritten: true, inputDecisions: [0, 1, 2], outputDecisions: [0, 1, 2] },
      traceDecisionCount: 3,
    });
    expect(audit.complete).toBe(true);
    expect(audit.note).toBe('every decision boundary captured');
  });

  it('still calls a run complete when only its final output is missing', () => {
    // A timed-out run genuinely has a last decision the model never answered. Reporting
    // that as a broken capture would point the reader at the wrong problem.
    const audit = buildCaptureAudit({
      ...base,
      stats: { headerWritten: true, inputDecisions: [0, 1, 2], outputDecisions: [0, 1] },
      traceDecisionCount: 3,
    });
    expect(audit.complete).toBe(true);
    expect(audit.decisionsMissingOutput).toEqual([2]);
    expect(audit.note).toContain('aborted, timed out or lost its provider');
  });

  it('is incomplete when a boundary in the trace has no captured input', () => {
    const audit = buildCaptureAudit({
      ...base,
      stats: { headerWritten: true, inputDecisions: [0, 2], outputDecisions: [0, 1, 2] },
      traceDecisionCount: 3,
    });
    expect(audit.complete).toBe(false);
    expect(audit.decisionsMissingInput).toEqual([1]);
  });

  it('is incomplete when the run died before its session existed', () => {
    const audit = buildCaptureAudit({
      ...base,
      stats: { headerWritten: false, inputDecisions: [], outputDecisions: [] },
      traceDecisionCount: 0,
    });
    expect(audit.complete).toBe(false);
    expect(audit.note).toContain('before its session existed');
  });

  it('reports the exact failure count even when the recorded list is capped', () => {
    const audit = buildCaptureAudit({
      ...base,
      engine: {
        ...base.engine,
        failures: Array.from({ length: 50 }, () => ({
          stage: 'call_input' as const,
          decisionIndex: 1,
          message: 'boom',
        })),
        failureCount: 50,
      },
      stats: { headerWritten: true, inputDecisions: [0], outputDecisions: [0] },
      traceDecisionCount: 1,
    });
    expect(audit.failureCount).toBe(50);
    expect(audit.failures.length).toBeLessThanOrEqual(20);
    expect(audit.complete).toBe(false);
  });

  it('says so when the system prompt is the configured text rather than the effective one', () => {
    const audit = buildCaptureAudit({
      ...base,
      systemPromptSource: 'harness_configured',
      stats: { headerWritten: true, inputDecisions: [0], outputDecisions: [0] },
      traceDecisionCount: 1,
    });
    expect(audit.note).toContain('not the effective runtime prompt');
  });
});

describe('readEffectiveSystemPrompt', () => {
  it('reads the live session getter', () => {
    expect(readEffectiveSystemPrompt({ systemPrompt: 'You are a coding agent.' })).toBe(
      'You are a coding agent.',
    );
  });

  it('returns undefined rather than substituting something else', () => {
    expect(readEffectiveSystemPrompt(undefined)).toBeUndefined();
    expect(readEffectiveSystemPrompt({})).toBeUndefined();
    expect(
      readEffectiveSystemPrompt({
        get systemPrompt(): string {
          throw new Error('runtime changed');
        },
      }),
    ).toBeUndefined();
  });
});

describe('capture review regressions', () => {
  it('labels output truncation and redaction instead of silently shortening it', async () => {
    const setup = harness();
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    await setup.engine.settleTurn({
      assistantText: 'x'.repeat(MAX_MESSAGE_TEXT + 100),
      reasoningText: 'password: hidden-value',
      stopReason: 'stop',
      toolCallNames: [],
    });
    const output = outputs(setup.captured)[0]!;
    expect(output.textCapture).toEqual({
      truncated: true,
      chars: MAX_MESSAGE_TEXT + 100,
      redacted: false,
    });
    expect(output.reasoningCapture?.redacted).toBe(true);
    expect(output.reasoningText).not.toContain('hidden-value');
  });

  it('redacts credentials embedded in JSON file text', () => {
    const captured = captureMessage({
      role: 'toolResult',
      content: '{"password":"sample-opaque-value","api_key":"another-opaque-value"}',
    });
    expect(captured.redacted).toBe(true);
    expect(captured.text).not.toContain('sample-opaque-value');
    expect(captured.text).not.toContain('another-opaque-value');
  });

  it('detects equal counts with the wrong decision identities and missing settled outputs', () => {
    const audit = buildCaptureAudit({
      contextPath: '/tmp/capture',
      stats: { headerWritten: true, inputDecisions: [0, 9], outputDecisions: [0] },
      engine: {
        failures: [],
        failureCount: 0,
        truncatedMessageCount: 0,
        redactedMessageCount: 0,
        omittedBlockMessageCount: 0,
      },
      runnerFailures: [],
      traceDecisionCount: 2,
      traceDecisions: [0, 1],
      traceOutputDecisions: [0, 1],
      systemPromptSource: 'runtime_session',
    });
    expect(audit.complete).toBe(false);
    expect(audit.decisionsMissingInput).toEqual([1]);
    expect(audit.note).toContain('settled turns missing');
    expect(audit.note).toContain('without trace boundaries');
  });
});
