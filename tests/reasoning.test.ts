/**
 * Reasoning capture at the Pi seam.
 *
 * `assistantInfo` is the only place a model's thinking can be recovered — Pi hands the
 * harness one `AssistantMessage` per turn and nothing downstream can reconstruct what was
 * in it. These tests pin the shapes Pi's own types declare
 * (`content: (TextContent | ThinkingContent | ToolCall)[]`, `usage.reasoning`) against
 * plain object literals, so they hold without a provider, a network call or the SDK's
 * runtime.
 *
 * The distinction the tests exist to protect: `reasoning === undefined` means the provider
 * returned no thinking blocks, and that must never be confused with the harness having
 * failed to look. Everything the eval concludes about whether a model *noticed* an
 * environment change rests on that difference being honest.
 */

import { describe, expect, it } from 'vitest';

import { assistantInfo } from '../src/pi/adapter.js';
import { traceEventSchema, TRACE_SCHEMA_VERSION } from '../src/trace/schema.js';

describe('assistantInfo reasoning extraction', () => {
  it('collects thinking blocks alongside text and tool calls', () => {
    const info = assistantInfo({
      content: [
        { type: 'thinking', thinking: 'There is an unread mention. Check it first.' },
        { type: 'text', text: 'Checking Slack.' },
        { type: 'toolCall', id: 'c1', name: 'read_slack_messages', arguments: {} },
      ],
      stopReason: 'toolUse',
    });
    expect(info.reasoning).toBe('There is an unread mention. Check it first.');
    expect(info.text).toBe('Checking Slack.');
    expect(info.calls).toHaveLength(1);
    expect(info.calls[0]?.name).toBe('read_slack_messages');
  });

  it('joins several thinking blocks in source order', () => {
    const info = assistantInfo({
      content: [
        { type: 'thinking', thinking: 'first' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
        { type: 'thinking', thinking: 'second' },
      ],
      stopReason: 'toolUse',
    });
    expect(info.reasoning).toBe('first\nsecond');
  });

  it('leaves reasoning undefined when the provider returned none', () => {
    // Not an empty string: an absent capture and an empty one must stay distinguishable.
    const info = assistantInfo({
      content: [{ type: 'toolCall', id: 'c1', name: 'ls', arguments: {} }],
      stopReason: 'toolUse',
    });
    expect(info.reasoning).toBeUndefined();
    expect(info.reasoningRedacted).toBe(false);
  });

  it('records a redacted block as present-but-empty rather than absent', () => {
    // A safety filter withholding the plaintext still proves the model reasoned.
    const info = assistantInfo({
      content: [
        { type: 'thinking', thinking: '', thinkingSignature: 'op4qu3', redacted: true },
      ],
      stopReason: 'toolUse',
    });
    expect(info.reasoningRedacted).toBe(true);
    expect(info.reasoning).toBe('');
  });

  it('keeps whatever plaintext survived alongside a redacted sibling', () => {
    const info = assistantInfo({
      content: [
        { type: 'thinking', thinking: 'visible part' },
        { type: 'thinking', thinking: '', redacted: true },
      ],
      stopReason: 'toolUse',
    });
    expect(info.reasoning).toBe('visible part');
    expect(info.reasoningRedacted).toBe(true);
  });

  it('reads the reasoning token count when the provider reports a breakdown', () => {
    const info = assistantInfo({
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'stop',
      usage: { input: 100, output: 50, reasoning: 512, totalTokens: 150 },
    });
    expect(info.reasoningTokens).toBe(512);
  });

  it('leaves the token count undefined for providers that expose no breakdown', () => {
    const info = assistantInfo({
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'stop',
      usage: { input: 100, output: 50, totalTokens: 150 },
    });
    expect(info.reasoningTokens).toBeUndefined();
  });

  it('survives a malformed message rather than throwing mid-run', () => {
    for (const value of [null, undefined, 42, 'text', { content: 'not an array' }]) {
      expect(() => assistantInfo(value)).not.toThrow();
    }
    expect(assistantInfo(null).stopReason).toBe('unknown');
  });

  it('ignores a thinking block whose payload is not a string', () => {
    const info = assistantInfo({
      content: [{ type: 'thinking', thinking: { nested: true } }],
      stopReason: 'toolUse',
    });
    expect(info.reasoning).toBeUndefined();
  });
});

describe('reasoning in the trace schema', () => {
  const base = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    seq: 1,
    decisionIndex: 0,
    logicalActionIndex: 0,
    wallClockIso: '2026-01-01T00:00:00.000Z',
    type: 'assistant_turn' as const,
    turnIndex: 0,
    text: '',
    toolCallNames: ['read'],
    stopReason: 'toolUse',
  };

  it('accepts a turn carrying reasoning', () => {
    const parsed = traceEventSchema.parse({
      ...base,
      reasoningText: 'checking the channel',
      reasoningRedacted: false,
      reasoningTokens: 128,
    });
    expect(parsed).toMatchObject({ reasoningText: 'checking the channel' });
  });

  it('accepts a turn with no reasoning fields at all', () => {
    // Optional on purpose: omitting them is how "the provider returned none" is recorded,
    // and it is also what lets a v1–v3 trace normalise onto this schema untouched.
    const parsed = traceEventSchema.parse(base);
    expect(parsed).not.toHaveProperty('reasoningText');
  });

  it('rejects a negative reasoning token count', () => {
    expect(() => traceEventSchema.parse({ ...base, reasoningTokens: -1 })).toThrow();
  });
});
