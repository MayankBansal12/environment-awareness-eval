import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import * as muse from '../src/harness/free-model.js';
import {
  assertSelectedModel,
  createRuntime,
  DEFAULT_SELECTION,
  matchesRuntimeIdentity,
  modelSelectionSchema,
  selectModel,
  type ModelSelection,
} from '../src/harness/model.js';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;
vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual('node:fs/promises')),
  readFile: vi.fn(),
}));
const selection: ModelSelection = {
  provider: 'openai-codex',
  model: 'gpt-6-astra',
  thinking: 'medium',
};
const catalogModel: Model = {
  id: selection.model,
  provider: selection.provider,
  name: 'GPT-6 Astra',
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  contextWindow: 272000,
  maxTokens: 128000,
  reasoning: true,
  input: ['text', 'image'],
  thinkingLevelMap: { medium: 'medium', high: 'high' },
};
const context = { messages: [] };

function mockRuntime(model: Model | undefined = structuredClone(catalogModel)) {
  const stream = vi.fn(() => ({ marker: 'stream' }));
  const refresh = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
  const checkAuth = vi.fn(async () => ({ type: 'oauth' }));
  const runtime = {
    refresh,
    checkAuth,
    getModel: vi.fn(() => model),
    registerProvider: vi.fn(),
    streamSimple: stream,
  } as unknown as ModelRuntime;
  const create = vi.spyOn(ModelRuntime, 'create').mockResolvedValue(runtime);
  return { runtime, stream, refresh, checkAuth, create };
}
beforeEach(() => vi.mocked(readFile).mockRejectedValue({ code: 'ENOENT' }));
afterEach(() => vi.restoreAllMocks());

describe('explicit model runtime', () => {
  const opusSelection = {
    provider: 'anthropic',
    model: 'claude-opus-5',
    thinking: 'default',
  } as const;
  it('selects the native Claude Code default independently of the Pi high default', () => {
    expect(selectModel({ provider: 'anthropic', model: 'claude-opus-5' })).toEqual(
      opusSelection,
    );
    expect(selectModel({ provider: 'anthropic', model: 'claude-sonnet-5' })).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      thinking: 'default',
    });
    expect(selectModel({})).toEqual(DEFAULT_SELECTION);
    for (const change of [
      { model: 'opus' },
      { model: 'claude-opus-4-8' },
      { model: 'claude-sonnet-4-5' },
      { provider: 'openrouter' },
      { thinking: 'high' },
      { thinking: 'off' },
    ])
      expect(() => selectModel({ ...opusSelection, ...change })).toThrow();
  });

  it('accepts the exact claude-sonnet-5 selection and audits it like Opus', () => {
    const sonnet = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      thinking: 'default',
    } as const;
    expect(modelSelectionSchema.safeParse(sonnet).success).toBe(true);
    expect(modelSelectionSchema.safeParse({ ...sonnet, thinking: 'high' }).success).toBe(
      false,
    );
    const identity = {
      ...sonnet,
      requested: sonnet,
      agent: 'claude-code',
      agentVersion: '2.1.266 (Claude Code)',
      api: 'claude-code-agent-sdk',
      authSource: 'claude-code',
      maxOutputTokens: 8192,
      outputBudgetTransport: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      contextCapture: 'claude-code-hooks',
    };
    expect(matchesRuntimeIdentity(identity)).toBe(true);
    expect(matchesRuntimeIdentity({ ...identity, requested: opusSelection })).toBe(false);
    for (const change of [
      { agent: 'pi' },
      { api: 'anthropic-messages' },
      { authSource: 'claude-code-read-only' },
      { agentVersion: undefined },
      { contextCapture: undefined },
    ])
      expect(matchesRuntimeIdentity({ ...identity, ...change })).toBe(false);
  });

  it('routes Opus to Claude Code and audits its agent identity', async () => {
    const fake = mockRuntime();
    await expect(createRuntime(opusSelection)).rejects.toThrow('Claude Code');
    expect(fake.create).not.toHaveBeenCalled();
    const identity = {
      ...opusSelection,
      requested: opusSelection,
      agent: 'claude-code',
      agentVersion: '2.1.266 (Claude Code)',
      api: 'claude-code-agent-sdk',
      authSource: 'claude-code',
      maxOutputTokens: 8192,
      outputBudgetTransport: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      contextCapture: 'claude-code-hooks',
    };
    expect(matchesRuntimeIdentity(identity)).toBe(true);
    for (const change of [
      { agent: 'pi' },
      { api: 'anthropic-messages' },
      { authSource: 'claude-code-read-only' },
      { agentVersion: undefined },
      { contextCapture: undefined },
    ])
      expect(matchesRuntimeIdentity({ ...identity, ...change })).toBe(false);
  });

  it('retains Muse/high by default and accepts only the authorized provider/model tuples', () => {
    expect(DEFAULT_SELECTION).toEqual({
      provider: 'opencode',
      model: muse.FREE_MODEL,
      thinking: 'high',
    });
    for (const model of ['gpt-6-astra', 'gpt-5.6-sol']) {
      for (const thinking of ['medium', 'high'])
        expect(
          modelSelectionSchema.safeParse({ ...selection, model, thinking }).success,
        ).toBe(true);
    }
    for (const change of [
      { provider: 'openai' },
      { model: 'gpt-5' },
      { model: muse.FREE_MODEL },
      { thinking: 'low' },
      { thinking: undefined },
      { fallback: 'gpt-5.6-sol' },
    ])
      expect(modelSelectionSchema.safeParse({ ...selection, ...change }).success).toBe(
        false,
      );
  });

  it('rejects routing and free-pricing substitutions before any model call', () => {
    expect(() => assertSelectedModel(catalogModel, selection)).not.toThrow();
    for (const change of [
      { id: 'gpt-5.6-sol' },
      { provider: 'openai' },
      { api: 'openai-responses' as const },
      { baseUrl: 'https://api.openai.com/v1' },
      { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { cost: { ...catalogModel.cost, input: Number.NaN } },
    ])
      expect(() => assertSelectedModel({ ...catalogModel, ...change }, selection)).toThrow(
        'Inference refused',
      );
  });

  it('uses native refreshable credentials, exact catalog identity, and guards every request', async () => {
    const fake = mockRuntime();
    const input = structuredClone(selection);
    const result = await createRuntime(input);
    input.thinking = 'high';
    expect(fake.create).toHaveBeenCalledWith({ modelsPath: null, refreshOnCreate: false });
    expect(fake.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ['openai-codex'], allowNetwork: true }),
    );
    expect(result.model.maxTokens).toBe(8192);
    expect(result.thinking).toBe('medium');
    expect(result.verification).toMatchObject({
      ...selection,
      requested: selection,
      pricing: 'provider-account',
      maxOutputTokens: 8192,
      requestedMaxOutputTokens: 8192,
      maxOutputTokensEnforced: false,
      providerMaxOutputTokens: 128000,
      outputBudgetTransport: 'not-sent-by-pi-codex',
    });
    expect(matchesRuntimeIdentity(result.verification)).toBe(true);
    expect(fake.stream).not.toHaveBeenCalled();
    for (const thinking of [undefined, 'high'] as const)
      expect(() =>
        result.runtime.streamSimple(
          result.model,
          context,
          thinking ? { reasoning: thinking } : {},
        ),
      ).toThrow('reasoning');
    expect(() =>
      result.runtime.streamSimple({ ...result.model, id: 'gpt-5.6-sol' }, context, {
        reasoning: 'medium',
      }),
    ).toThrow('identity');
    expect(() =>
      result.runtime.streamSimple(
        { ...result.model, thinkingLevelMap: { medium: 'low' } },
        context,
        { reasoning: 'medium' },
      ),
    ).toThrow('identity');
    expect(() =>
      result.runtime.streamSimple(result.model, context, {
        reasoning: 'medium',
        maxTokens: 16384,
      }),
    ).toThrow('output budget');
    expect(fake.stream).not.toHaveBeenCalled();
    result.runtime.streamSimple(result.model, context, { reasoning: 'medium' });
    expect(fake.stream).toHaveBeenCalledWith(result.model, context, {
      reasoning: 'medium',
      maxTokens: 8192,
    });
  });

  it('refuses unavailable or failed catalog selection and unavailable credentials', async () => {
    const fake = mockRuntime();
    vi.mocked(fake.runtime.getModel).mockReturnValue(undefined);
    await expect(createRuntime(selection)).rejects.toThrow('unavailable');
    vi.mocked(fake.runtime.getModel).mockReturnValue(catalogModel);
    fake.refresh.mockResolvedValue({
      aborted: false,
      errors: new Map([['openai-codex', new Error('offline')]]),
    });
    await expect(createRuntime(selection)).rejects.toThrow('catalog');
    fake.refresh.mockResolvedValue({ aborted: false, errors: new Map() });
    vi.mocked(fake.runtime.checkAuth).mockResolvedValue(undefined);
    await expect(createRuntime(selection)).rejects.toThrow('credential');
    expect(fake.stream).not.toHaveBeenCalled();
  });

  it('retains the existing credential resolver without importing routing overrides or disclosing it', async () => {
    const fake = mockRuntime();
    const resolver = '!existing-auth-helper';
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        providers: {
          'openai-codex': {
            apiKey: resolver,
            baseUrl: 'https://unselected.invalid',
            models: [],
          },
          another: { apiKey: 'unrelated' },
        },
      }),
    );
    const { verification } = await createRuntime(selection);
    expect(fake.runtime.registerProvider).toHaveBeenCalledOnce();
    expect(fake.runtime.registerProvider).toHaveBeenCalledWith('openai-codex', {
      apiKey: resolver,
    });
    expect(JSON.stringify(verification)).not.toContain(resolver);
    expect(verification.baseUrl).toBe(catalogModel.baseUrl);
  });

  it('refuses a model whose reasoning mapping silently downgrades the request', async () => {
    const fake = mockRuntime({ ...catalogModel, thinkingLevelMap: { medium: 'low' } });
    await expect(createRuntime(selection)).rejects.toThrow('identity');
    expect(fake.stream).not.toHaveBeenCalled();
  });

  it('keeps the verified free runtime for Muse and adds explicit requested identity', async () => {
    const model: Model = {
      ...catalogModel,
      provider: muse.FREE_PROVIDER,
      id: muse.FREE_MODEL,
      api: 'openai-responses',
      baseUrl: muse.ZEN_BASE_URL,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const fake = mockRuntime(model);
    const legacy = {
      provider: muse.FREE_PROVIDER,
      model: muse.FREE_MODEL,
      api: 'openai-responses',
      baseUrl: muse.ZEN_BASE_URL,
      pricing: 'free',
      verifiedAt: '2026-09-12T00:00:00.000Z',
      pricingSource: 'https://opencode.ai/docs/zen/',
      catalogSource: muse.ZEN_BASE_URL + '/models',
      maxOutputTokens: 8192,
    };
    const free = vi
      .spyOn(muse, 'freeRuntime')
      .mockResolvedValue({ runtime: fake.runtime, model, verification: legacy });
    const result = await createRuntime();
    expect(free).toHaveBeenCalledOnce();
    expect(fake.create).not.toHaveBeenCalled();
    expect(result.verification.requested).toEqual(DEFAULT_SELECTION);
    expect(matchesRuntimeIdentity(result.verification)).toBe(true);
    expect(matchesRuntimeIdentity(legacy)).toBe(false);
  });

  it('audits exact requested identity and records that Codex cannot enforce the requested cap', async () => {
    mockRuntime();
    const { verification } = await createRuntime(selection);
    for (const change of [
      { requested: undefined },
      { requested: { ...selection, thinking: 'high' } },
      { model: 'gpt-5.6-sol' },
      { thinking: undefined },
      { api: 'openai-responses' },
      { baseUrl: muse.ZEN_BASE_URL },
      { pricing: 'free' },
      { maxOutputTokens: 128000 },
      { maxOutputTokensEnforced: true },
      { catalogCost: undefined },
      { catalogCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ])
      expect(matchesRuntimeIdentity({ ...verification, ...change })).toBe(false);
    for (const value of [undefined, null, [], {}, 'model'])
      expect(matchesRuntimeIdentity(value)).toBe(false);
  });
});

describe('OpenCode Go exact Pi models', () => {
  for (const model of [
    'glm-5.3-flash',
    'muse-spark-1.3-contributor',
    'deepseek-v4.1-flash',
  ] as const) {
    it(`selects, caps and audits ${model} without fallback`, async () => {
      const selected = { provider: 'opencode-go', model, thinking: 'high' } as const;
      const responses = model.startsWith('muse');
      const actual: Model = {
        ...catalogModel,
        provider: selected.provider,
        id: model,
        api: responses ? 'openai-responses' : 'openai-completions',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        compat: responses
          ? { sessionAffinityFormat: 'openai-nosession' }
          : { maxTokensField: 'max_tokens' },
        thinkingLevelMap: { high: 'high' },
      };
      const mock = mockRuntime(actual);
      expect(selectModel({ provider: selected.provider, model })).toEqual(selected);
      const configured = await createRuntime(selected);
      expect(configured.model.maxTokens).toBe(8192);
      expect(matchesRuntimeIdentity(configured.verification)).toBe(true);
      expect(configured.verification).toMatchObject({
        maxOutputTokensEnforced: true,
        resolvedThinking: 'high',
        outputBudgetTransport: responses ? 'openai-max_output_tokens' : 'openai-max_tokens',
      });
      configured.runtime.streamSimple(configured.model, context, {
        reasoning: 'high',
        maxTokens: 8192,
      });
      expect(mock.stream).toHaveBeenCalledWith(configured.model, context, {
        reasoning: 'high',
        maxTokens: 8192,
      });
      configured.runtime.streamSimple(configured.model, context, { maxTokens: 4096 });
      expect(mock.stream).toHaveBeenLastCalledWith(configured.model, context, {
        reasoning: 'high',
        maxTokens: 4096,
      });
      expect(() =>
        configured.runtime.streamSimple(configured.model, context, { reasoning: 'medium' }),
      ).toThrow();
      expect(() =>
        configured.runtime.streamSimple(configured.model, context, { maxTokens: 8193 }),
      ).toThrow();
      expect(() => assertSelectedModel({ ...actual, id: 'other' }, selected)).toThrow();
      expect(() =>
        assertSelectedModel({ ...actual, baseUrl: 'https://example.com' }, selected),
      ).toThrow();
      expect(() =>
        assertSelectedModel({ ...actual, thinkingLevelMap: { high: null } }, selected),
      ).toThrow();
      expect(
        matchesRuntimeIdentity({
          ...configured.verification,
          maxOutputTokensEnforced: false,
        }),
      ).toBe(false);
      expect(
        matchesRuntimeIdentity({
          ...configured.verification,
          outputBudgetTransport: 'not-sent-by-pi-codex',
        }),
      ).toBe(false);
      expect(
        modelSelectionSchema.safeParse({ ...selected, thinking: 'medium' }).success,
      ).toBe(false);
      expect(
        modelSelectionSchema.safeParse({ ...selected, model: model + '-free' }).success,
      ).toBe(false);
    });
  }
});
