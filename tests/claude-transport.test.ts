import { afterEach, expect, it, vi } from 'vitest';
import { generateSummary, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import * as auth from '../src/harness/claude-auth.js';
import { createRuntime } from '../src/harness/model.js';

afterEach(() => vi.restoreAllMocks());

it('serializes actual native Pi OAuth turn and compaction payloads as exact Opus 5 adaptive/high', async () => {
  const native = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => ({ type: 'api_key', key: 'sk-ant-oat-fake-test-only' }),
      list: async () => [{ providerId: 'anthropic', type: 'api_key' }],
      modify: async () => {
        throw Error('unused');
      },
      delete: async () => {
        throw Error('unused');
      },
    },
  });
  vi.spyOn(auth, 'createClaudeRuntime').mockResolvedValue({
    runtime: native,
    authSource: 'claude-code-read-only',
  });
  vi.spyOn(native, 'refresh').mockResolvedValue({ aborted: false, errors: new Map() });
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Network forbidden in test'));
  const { runtime, model, thinking } = await createRuntime({
    provider: 'anthropic',
    model: 'claude-opus-5',
    thinking: 'default',
  });
  const payloads: Record<string, unknown>[] = [];
  const onPayload = (payload: unknown) => {
    payloads.push(payload as Record<string, unknown>);
    throw Error('Payload captured before network');
  };
  const messages = [{ role: 'user' as const, content: 'Reply OK', timestamp: 0 }];
  await runtime
    .streamSimple(
      model,
      {
        systemPrompt: 'Controlled system prompt',
        messages,
        tools: [
          {
            name: 'read',
            description: 'Controlled read',
            parameters: Type.Object({ path: Type.String() }),
          },
        ],
      },
      { reasoning: thinking, onPayload },
    )
    .result();
  // Exercise Pi's real summary budget calculation (0.8 * reserveTokens), not a
  // hand-written approximation of its options. Omitted reasoning is default, not off.
  await expect(
    generateSummary(
      messages,
      model,
      2560,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (actual, context, options) =>
        runtime.streamSimple(actual, context, { ...options, onPayload }),
    ),
  ).rejects.toThrow('Payload captured');
  expect(fetch).not.toHaveBeenCalled();
  expect(payloads).toHaveLength(2);
  for (const payload of payloads) {
    expect(payload).toMatchObject({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
  }
  expect(payloads[0]?.['max_tokens']).toBe(8192);
  expect(payloads[1]?.['max_tokens']).toBe(2048);
  // Native OAuth transport adds its Claude Code preamble and canonicalizes tool
  // names. This is transport provenance, not a change to the eval's prompt source.
  expect(JSON.stringify(payloads[0]?.['system'])).toContain('Controlled system prompt');
  expect(JSON.stringify(payloads[0]?.['system'])).toContain('Claude Code');
  expect(payloads[0]?.['tools']).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'Read' })]),
  );
});
