import { expect, it } from 'vitest';
import { codexMessage } from '../src/harness/codex.js';
import { matchesRuntimeIdentity, selectModel } from '../src/harness/model.js';
import { redactMetadata } from '../src/harness/redact.js';

it('leaves native reasoning defaults unset while retaining the resolved effort in audit identity', () => {
  for (const [model, resolvedThinking] of [
    ['gpt-6-astra', 'medium'],
    ['gpt-5.6-sol', 'low'],
  ]) {
    const selection = selectModel({ provider: 'openai-codex', model: model! });
    expect(selection.thinking).toBe('default');
    const identity = {
      ...selection,
      requested: selection,
      agent: 'codex',
      agentVersion: '0.153.4',
      api: 'codex-app-server',
      authSource: 'codex',
      contextCapture: 'codex-transport-observer',
      outputBudgetTransport: 'native-default',
      maxOutputTokens: null,
      fallbackPolicy: 'none',
      resolvedThinking,
      catalogCost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
    };
    expect(matchesRuntimeIdentity(identity)).toBe(true);
    expect(
      matchesRuntimeIdentity({
        ...identity,
        requested: { ...selection, model: 'unrequested' },
      }),
    ).toBe(false);
    expect(matchesRuntimeIdentity({ ...identity, maxOutputTokens: 8192 })).toBe(false);
  }
});

it('keeps cached input separate and applies the context pricing tier without double-counting reasoning', () => {
  const result = codexMessage(
    {
      status: 'completed',
      usage: {
        input_tokens: 300000,
        input_tokens_details: { cached_tokens: 200000 },
        output_tokens: 1000,
        output_tokens_details: { reasoning_tokens: 600 },
        total_tokens: 301000,
      },
    },
    [],
    {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      tiers: [
        { inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
      ],
    },
  );
  expect(result.usage).toMatchObject({
    input: 100000,
    cacheRead: 200000,
    output: 1000,
    reasoning: 600,
    totalTokens: 301000,
  });
  expect(result.usage.cost.total).toBeCloseTo(1.245);
});

it('redacts native log strings before JSON encoding so backslashes and quotes remain parseable', () => {
  const value = {
    text: 'const secret="sensitive-value";\nnext();',
    args: { content: 'password=test-value\nmore "quoted" text' },
  };
  const encoded = JSON.stringify(redactMetadata(value));
  expect(() => JSON.parse(encoded)).not.toThrow();
  expect(encoded).not.toContain('sensitive-value');
  expect(encoded).not.toContain('test-value');
  expect(JSON.parse(encoded).args.content).toContain('more "quoted" text');
});
