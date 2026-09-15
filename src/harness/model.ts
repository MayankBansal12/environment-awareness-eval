import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createClaudeRuntime } from './claude-auth.js';
import {
  assertFreeModel,
  FREE_MODEL,
  FREE_PROVIDER,
  freeRuntime,
  ZEN_BASE_URL,
} from './free-model.js';

const thinkingSchema = z.enum(['medium', 'high']);
export const modelSelectionSchema = z.union([
  z
    .object({
      provider: z.literal('anthropic'),
      model: z.literal('claude-opus-5'),
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
      thinking: thinkingSchema,
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
// Anthropic documents Opus 5's API default as high, equivalent to omitted effort.
// Resolve independently of DEFAULT_SELECTION and Pi's defaults.
export function resolvedThinking(selection: ModelSelection): 'medium' | 'high' {
  return selection.provider === 'anthropic' ? 'high' : selection.thinking;
}

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
      (values.provider === 'anthropic' ? 'default' : DEFAULT_SELECTION.thinking),
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
  if (requested.provider === FREE_PROVIDER) {
    assertFreeModel(actual);
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
    (actual.thinkingLevelMap?.[resolvedThinking(requested)] !== undefined &&
      actual.thinkingLevelMap[resolvedThinking(requested)] !== resolvedThinking(requested))
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
    request.data.thinking !== selection.thinking ||
    identity['maxOutputTokens'] !== MAX_OUTPUT_TOKENS
  )
    return false;
  if (selection.provider === FREE_PROVIDER) {
    return (
      identity['api'] === 'openai-responses' &&
      identity['baseUrl'] === ZEN_BASE_URL &&
      identity['pricing'] === 'free'
    );
  }
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

async function configuredCodexAuthentication(): Promise<string | undefined> {
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
  const auth = record(record(record(config)?.['providers'])?.['openai-codex'])?.['apiKey'];
  if (auth !== undefined && typeof auth !== 'string')
    throw new Error(
      'Existing Pi authentication configuration has an invalid apiKey setting',
    );
  return auth;
}

export async function createRuntime(selection: ModelSelection = DEFAULT_SELECTION) {
  // Capture the selection before awaits so caller mutation cannot change authorization.
  const requested = modelSelectionSchema.parse(selection);
  let configured;
  if (requested.provider === FREE_PROVIDER) {
    configured = await freeRuntime();
  } else {
    // Preserve native coordinated OAuth refresh where configured. The Claude CLI
    // bridge instead leaves refresh with Claude Code and refuses expired tokens.
    // Ignore user model overrides and keep the fetched model catalog in memory.
    const claude = requested.provider === 'anthropic';
    const claudeRuntime = claude ? await createClaudeRuntime() : undefined;
    const runtime =
      claudeRuntime?.runtime ??
      (await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }));
    // Some installations resolve subscription credentials through models.json's
    // apiKey command. Retain that authentication setting while excluding model,
    // endpoint, headers, and transport overrides. Pi resolves it without logging.
    const apiKey = claude ? undefined : await configuredCodexAuthentication();
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
      (catalogModel.thinkingLevelMap?.[resolvedThinking(requested)] !== undefined &&
        catalogModel.thinkingLevelMap[resolvedThinking(requested)] !==
          resolvedThinking(requested))
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
        catalogSource: claude ? CLAUDE_CATALOG : CODEX_CATALOG,
        ...(claude
          ? {
              authSource: claudeRuntime!.authSource,
              resolvedThinking: 'high',
              thinkingMode: 'adaptive',
              reasoningDefaultSource: CLAUDE_DEFAULT_SOURCE,
              effortTransport: 'explicit-high-equivalent-to-api-default',
            }
          : {}),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // Pi 0.84.4's Codex request builder does not serialize maxTokens. Keep
        // the requested cap explicit without claiming that the backend enforces it.
        requestedMaxOutputTokens: MAX_OUTPUT_TOKENS,
        maxOutputTokensEnforced: claude,
        providerMaxOutputTokens: catalogModel.maxTokens,
        outputBudgetTransport: claude ? 'anthropic-max_tokens' : 'not-sent-by-pi-codex',
      },
    };
  }
  const { runtime, model } = configured;
  assertSelectedModel(model, requested);
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (actual, context, options) => {
    assertSelectedModel(actual, requested);
    const reasoning =
      options?.reasoning ??
      (requested.provider === 'anthropic' ? resolvedThinking(requested) : undefined);
    if (reasoning !== resolvedThinking(requested))
      throw new Error('Inference refused: reasoning differs from the explicit selection');
    const maxTokens = options?.maxTokens ?? MAX_OUTPUT_TOKENS;
    if (
      actual.maxTokens !== MAX_OUTPUT_TOKENS ||
      (requested.provider === 'anthropic'
        ? !Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_OUTPUT_TOKENS
        : maxTokens !== MAX_OUTPUT_TOKENS)
    )
      throw new Error('Inference refused: output budget differs from the frozen limit');
    const guardedOptions = { ...options, reasoning, maxTokens };
    // Pi may pass a previously resolved token to its summary calls. Resolve again
    // through the credential store so the Claude bridge checks expiry every time.
    if (requested.provider === 'anthropic') delete guardedOptions.apiKey;
    return stream(actual, context, guardedOptions);
  };
  return {
    runtime,
    model,
    thinking: resolvedThinking(requested),
    verification: {
      ...configured.verification,
      thinking: requested.thinking,
      requested: { ...requested },
    },
  };
}
