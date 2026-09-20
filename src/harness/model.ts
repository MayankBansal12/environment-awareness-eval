import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  assertFreeModel,
  FREE_MODEL,
  FREE_PROVIDER,
  freeRuntime,
  ZEN_BASE_URL,
} from './free-model.js';

const thinkingSchema = z.enum(['medium', 'high']);
export const GO_MODELS = [
  'glm-5.3-flash',
  'muse-spark-1.3-contributor',
  'deepseek-v4.1-flash',
] as const;
const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
const GO_CATALOG = 'https://pi.dev/api/models/providers/opencode-go';
function goApi(model: string) {
  return model === 'muse-spark-1.3-contributor' ? 'openai-responses' : 'openai-completions';
}
function goBudgetTransport(model: string) {
  return model === 'muse-spark-1.3-contributor'
    ? 'openai-max_output_tokens'
    : 'openai-max_tokens';
}
export const CLAUDE_MODELS = ['claude-opus-5', 'claude-sonnet-5'] as const;
export const modelSelectionSchema = z.union([
  z
    .object({
      provider: z.literal('opencode-go'),
      model: z.enum(GO_MODELS),
      thinking: z.literal('high'),
    })
    .strict(),
  z
    .object({
      provider: z.literal('anthropic'),
      model: z.enum(CLAUDE_MODELS),
      thinking: z.literal('default'),
    })
    .strict(),
  z
    .object({
      provider: z.literal(FREE_PROVIDER),
      model: z.literal(FREE_MODEL),
      thinking: thinkingSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal('openai-codex'),
      model: z.enum(['gpt-6-astra', 'gpt-5.6-sol']),
      thinking: z.enum(['default', 'medium', 'high']),
    })
    .strict(),
]);
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export const DEFAULT_SELECTION: ModelSelection = Object.freeze({
  provider: FREE_PROVIDER,
  model: FREE_MODEL,
  thinking: 'high',
});

const CODEX_API = 'openai-codex-responses';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_CATALOG = 'https://pi.dev/api/models/providers/openai-codex';
const CLAUDE_API = 'anthropic-messages';
const CLAUDE_BASE_URL = 'https://api.anthropic.com';
const CLAUDE_CATALOG = 'https://pi.dev/api/models/providers/anthropic';
const CLAUDE_DEFAULT_SOURCE =
  'https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-opus-5';
export function selectModel(values: {
  provider?: string;
  model?: string;
  thinking?: string;
}): ModelSelection {
  return modelSelectionSchema.parse({
    provider: values.provider ?? DEFAULT_SELECTION.provider,
    model: values.model ?? DEFAULT_SELECTION.model,
    thinking:
      values.thinking ??
      (['anthropic', 'openai-codex'].includes(values.provider ?? '')
        ? 'default'
        : DEFAULT_SELECTION.thinking),
  });
}
const MAX_OUTPUT_TOKENS = 8192;
type ModelMetadata = Pick<
  NonNullable<ReturnType<ModelRuntime['getModel']>>,
  | 'id'
  | 'provider'
  | 'api'
  | 'baseUrl'
  | 'cost'
  | 'reasoning'
  | 'thinkingLevelMap'
  | 'compat'
>;

function validPaidCost(cost: ModelMetadata['cost']): boolean {
  return (
    [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(
      (n) => Number.isFinite(n) && n >= 0,
    ) &&
    cost.input > 0 &&
    cost.output > 0
  );
}

/** Refuse another model, provider, transport, endpoint, or free-price substitution. */
export function assertSelectedModel(
  actual: ModelMetadata,
  selection: ModelSelection,
): void {
  const requested = modelSelectionSchema.parse(selection);
  const thinking = requested.thinking === 'default' ? 'high' : requested.thinking;
  if (requested.provider === FREE_PROVIDER) {
    assertFreeModel(actual);
    return;
  }
  if (requested.provider === 'opencode-go') {
    if (
      actual.provider !== requested.provider ||
      actual.id !== requested.model ||
      actual.api !== goApi(requested.model) ||
      actual.baseUrl !== GO_BASE_URL ||
      !actual.reasoning ||
      !validPaidCost(actual.cost) ||
      actual.thinkingLevelMap?.high !== 'high' ||
      (actual.api === 'openai-completions' &&
        record(actual.compat)?.['maxTokensField'] !== 'max_tokens')
    )
      throw new Error(
        'Inference refused: Go model identity or transport differs from the explicit selection',
      );
    return;
  }
  if (
    actual.provider !== requested.provider ||
    actual.id !== requested.model ||
    actual.api !== (requested.provider === 'anthropic' ? CLAUDE_API : CODEX_API) ||
    actual.baseUrl !==
      (requested.provider === 'anthropic' ? CLAUDE_BASE_URL : CODEX_BASE_URL) ||
    (requested.provider === 'anthropic' &&
      record(actual.compat)?.['forceAdaptiveThinking'] !== true) ||
    !validPaidCost(actual.cost) ||
    !actual.reasoning ||
    (actual.thinkingLevelMap?.[thinking] !== undefined &&
      actual.thinkingLevelMap[thinking] !== thinking)
  )
    throw new Error(
      'Inference refused: model identity differs from the explicit selection',
    );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pure persisted identity check: the recorded identity must match the explicit selection. */
export function matchesRuntimeIdentity(value: unknown): boolean {
  const identity = record(value);
  if (!identity) return false;
  const result = modelSelectionSchema.safeParse({
    provider: identity['provider'],
    model: identity['model'],
    thinking: identity['thinking'],
  });
  if (!result.success) return false;
  const selection = result.data;
  const request = modelSelectionSchema.safeParse(identity['requested']);
  if (
    !request.success ||
    request.data.provider !== selection.provider ||
    request.data.model !== selection.model ||
    request.data.thinking !== selection.thinking
  )
    return false;
  if (identity['agent'] === 'codex') {
    const cost = record(identity['catalogCost']);
    return (
      selection.provider === 'openai-codex' &&
      identity['api'] === 'codex-app-server' &&
      typeof identity['agentVersion'] === 'string' &&
      ['codex', 'bb-account-pool'].includes(identity['authSource'] as string) &&
      identity['contextCapture'] === 'codex-transport-observer' &&
      identity['outputBudgetTransport'] === 'native-default' &&
      identity['maxOutputTokens'] === null &&
      identity['fallbackPolicy'] === 'none' &&
      ['low', 'medium', 'high'].includes(identity['resolvedThinking'] as string) &&
      (selection.thinking === 'default' ||
        identity['resolvedThinking'] === selection.thinking) &&
      cost !== undefined &&
      validPaidCost({
        input: cost['input'] as number,
        output: cost['output'] as number,
        cacheRead: cost['cacheRead'] as number,
        cacheWrite: cost['cacheWrite'] as number,
      })
    );
  }
  if (identity['maxOutputTokens'] !== MAX_OUTPUT_TOKENS) return false;
  if (identity['agent'] === 'claude-code') {
    return (
      selection.provider === 'anthropic' &&
      identity['api'] === 'claude-code-agent-sdk' &&
      typeof identity['agentVersion'] === 'string' &&
      identity['authSource'] === 'claude-code' &&
      identity['outputBudgetTransport'] === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS' &&
      identity['contextCapture'] === 'claude-code-hooks'
    );
  }
  if (selection.provider === FREE_PROVIDER) {
    return (
      identity['api'] === 'openai-responses' &&
      identity['baseUrl'] === ZEN_BASE_URL &&
      identity['pricing'] === 'free'
    );
  }
  if (selection.provider === 'opencode-go') {
    const cost = record(identity['catalogCost']);
    return (
      identity['api'] === goApi(selection.model) &&
      identity['baseUrl'] === GO_BASE_URL &&
      identity['pricing'] === 'provider-account' &&
      identity['catalogSource'] === GO_CATALOG &&
      identity['requestedMaxOutputTokens'] === MAX_OUTPUT_TOKENS &&
      identity['maxOutputTokensEnforced'] === true &&
      identity['outputBudgetTransport'] === goBudgetTransport(selection.model) &&
      identity['resolvedThinking'] === 'high' &&
      identity['effortTransport'] === 'explicit-high' &&
      typeof identity['providerMaxOutputTokens'] === 'number' &&
      Number.isFinite(identity['providerMaxOutputTokens']) &&
      identity['providerMaxOutputTokens'] >= MAX_OUTPUT_TOKENS &&
      cost !== undefined &&
      validPaidCost({
        input: cost['input'] as number,
        output: cost['output'] as number,
        cacheRead: cost['cacheRead'] as number,
        cacheWrite: cost['cacheWrite'] as number,
      })
    );
  }
  // Keep auditing historical Pi-hosted Opus results with their original identity.
  const cost = record(identity['catalogCost']);
  const claude = selection.provider === 'anthropic';
  return (
    identity['api'] === (claude ? CLAUDE_API : CODEX_API) &&
    identity['baseUrl'] === (claude ? CLAUDE_BASE_URL : CODEX_BASE_URL) &&
    identity['pricing'] === 'provider-account' &&
    identity['catalogSource'] === (claude ? CLAUDE_CATALOG : CODEX_CATALOG) &&
    identity['requestedMaxOutputTokens'] === MAX_OUTPUT_TOKENS &&
    identity['maxOutputTokensEnforced'] === claude &&
    identity['outputBudgetTransport'] ===
      (claude ? 'anthropic-max_tokens' : 'not-sent-by-pi-codex') &&
    (!claude ||
      (identity['resolvedThinking'] === 'high' &&
        identity['thinkingMode'] === 'adaptive' &&
        identity['reasoningDefaultSource'] === CLAUDE_DEFAULT_SOURCE &&
        identity['effortTransport'] === 'explicit-high-equivalent-to-api-default' &&
        ['native-pi', 'claude-code-read-only'].includes(
          identity['authSource'] as string,
        ))) &&
    typeof identity['providerMaxOutputTokens'] === 'number' &&
    Number.isFinite(identity['providerMaxOutputTokens']) &&
    identity['providerMaxOutputTokens'] >= MAX_OUTPUT_TOKENS &&
    cost !== undefined &&
    validPaidCost({
      input: cost['input'] as number,
      output: cost['output'] as number,
      cacheRead: cost['cacheRead'] as number,
      cacheWrite: cost['cacheWrite'] as number,
    })
  );
}

async function configuredAuthentication(provider: string): Promise<string | undefined> {
  let contents: string;
  try {
    contents = await readFile(path.join(getAgentDir(), 'models.json'), 'utf8');
  } catch (error) {
    if (record(error)?.['code'] === 'ENOENT') return undefined;
    throw new Error('Could not read existing Pi authentication configuration');
  }
  let config: unknown;
  try {
    config = JSON.parse(contents);
  } catch {
    throw new Error('Could not parse existing Pi authentication configuration');
  }
  const auth = record(record(record(config)?.['providers'])?.[provider])?.['apiKey'];
  if (auth !== undefined && typeof auth !== 'string')
    throw new Error(
      'Existing Pi authentication configuration has an invalid apiKey setting',
    );
  return auth;
}

export async function createRuntime(selection: ModelSelection = DEFAULT_SELECTION) {
  // Capture the selection before awaits so caller mutation cannot change authorization.
  const requested = modelSelectionSchema.parse(selection);
  if (requested.provider === 'anthropic')
    throw new Error('Claude models run through Claude Code, not the Pi model runtime');
  if (requested.thinking === 'default')
    throw new Error('Codex defaults require the native Codex agent');
  let configured;
  if (requested.provider === FREE_PROVIDER) {
    configured = await freeRuntime();
  } else {
    // Preserve native coordinated OAuth refresh where configured.
    // Ignore user model overrides and keep the fetched model catalog in memory.
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    // Some installations resolve subscription credentials through models.json's
    // apiKey command. Retain that authentication setting while excluding model,
    // endpoint, headers, and transport overrides. Pi resolves it without logging.
    const apiKey = await configuredAuthentication(requested.provider);
    if (apiKey !== undefined) runtime.registerProvider(requested.provider, { apiKey });
    const refresh = await runtime.refresh({
      providers: [requested.provider],
      allowNetwork: true,
      signal: AbortSignal.timeout(15000),
    });
    if (refresh.aborted || refresh.errors.has(requested.provider))
      throw new Error(
        'Could not verify the selected model catalog; no inference permitted',
      );
    const catalogModel = runtime.getModel(requested.provider, requested.model);
    if (!catalogModel)
      throw new Error('Selected model is unavailable; no fallback permitted');
    assertSelectedModel(catalogModel, requested);
    if (
      !catalogModel.reasoning ||
      catalogModel.maxTokens < MAX_OUTPUT_TOKENS ||
      (catalogModel.thinkingLevelMap?.[requested.thinking] !== undefined &&
        catalogModel.thinkingLevelMap[requested.thinking] !== requested.thinking)
    )
      throw new Error('Selected model cannot honor the reasoning/output budget');
    if (!(await runtime.checkAuth(requested.provider)))
      throw new Error('No selected provider credential available');
    const model = { ...catalogModel, maxTokens: MAX_OUTPUT_TOKENS };
    configured = {
      runtime,
      model,
      verification: {
        provider: requested.provider,
        model: requested.model,
        api: catalogModel.api,
        baseUrl: catalogModel.baseUrl,
        pricing: 'provider-account',
        catalogCost: structuredClone(catalogModel.cost),
        verifiedAt: new Date().toISOString(),
        catalogSource: requested.provider === 'opencode-go' ? GO_CATALOG : CODEX_CATALOG,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // Pi 0.84.4's Codex request builder does not serialize maxTokens. Keep
        // the requested cap explicit without claiming that the backend enforces it.
        requestedMaxOutputTokens: MAX_OUTPUT_TOKENS,
        maxOutputTokensEnforced: requested.provider === 'opencode-go',
        providerMaxOutputTokens: catalogModel.maxTokens,
        outputBudgetTransport:
          requested.provider === 'opencode-go'
            ? goBudgetTransport(requested.model)
            : 'not-sent-by-pi-codex',
        ...(requested.provider === 'opencode-go'
          ? { resolvedThinking: 'high', effortTransport: 'explicit-high' }
          : {}),
      },
    };
  }
  const { runtime, model } = configured;
  assertSelectedModel(model, requested);
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (actual, context, options) => {
    assertSelectedModel(actual, requested);
    const go = requested.provider === 'opencode-go';
    // Pi summaries may omit reasoning and use a smaller cap. Keep high explicit
    // and enforce the frozen cap as an upper bound for this transport.
    if (
      options?.reasoning !== requested.thinking &&
      !(go && options?.reasoning === undefined)
    )
      throw new Error('Inference refused: reasoning differs from the explicit selection');
    const maxTokens = options?.maxTokens ?? MAX_OUTPUT_TOKENS;
    if (
      actual.maxTokens !== MAX_OUTPUT_TOKENS ||
      (go
        ? !Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > MAX_OUTPUT_TOKENS
        : maxTokens !== MAX_OUTPUT_TOKENS)
    )
      throw new Error('Inference refused: output budget differs from the frozen limit');
    return stream(actual, context, {
      ...options,
      ...(go ? { reasoning: requested.thinking } : {}),
      maxTokens,
    });
  };
  return {
    runtime,
    model,
    thinking: requested.thinking,
    verification: {
      ...configured.verification,
      thinking: requested.thinking,
      requested: { ...requested },
    },
  };
}
