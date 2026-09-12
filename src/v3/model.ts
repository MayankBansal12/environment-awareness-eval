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
} from '../v2/model.js';

const thinkingSchema = z.enum(['medium', 'high']);
export const modelSelectionSchema = z.union([
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
const MAX_OUTPUT_TOKENS = 8192;
type ModelMetadata = Pick<
  NonNullable<ReturnType<ModelRuntime['getModel']>>,
  'id' | 'provider' | 'api' | 'baseUrl' | 'cost' | 'reasoning' | 'thinkingLevelMap'
>;

function validCodexCost(cost: ModelMetadata['cost']): boolean {
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
    actual.api !== CODEX_API ||
    actual.baseUrl !== CODEX_BASE_URL ||
    !validCodexCost(actual.cost) ||
    !actual.reasoning ||
    (actual.thinkingLevelMap?.[requested.thinking] !== undefined &&
      actual.thinkingLevelMap[requested.thinking] !== requested.thinking)
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

/** Pure persisted identity check; original Muse records predate explicit selection. */
export function matchesRuntimeIdentity(value: unknown): boolean {
  const identity = record(value);
  if (!identity) return false;
  const historicalMuse =
    identity['provider'] === FREE_PROVIDER &&
    identity['model'] === FREE_MODEL &&
    identity['requested'] === undefined &&
    identity['protocolVersion'] !== '3.2';
  const result = modelSelectionSchema.safeParse({
    provider: identity['provider'],
    model: identity['model'],
    thinking: identity['thinking'] ?? (historicalMuse ? 'high' : undefined),
  });
  if (!result.success) return false;
  const selection = result.data;
  if (!historicalMuse) {
    const request = modelSelectionSchema.safeParse(identity['requested']);
    if (
      !request.success ||
      request.data.provider !== selection.provider ||
      request.data.model !== selection.model ||
      request.data.thinking !== selection.thinking ||
      identity['maxOutputTokens'] !== MAX_OUTPUT_TOKENS
    )
      return false;
  }
  if (selection.provider === FREE_PROVIDER) {
    return (
      identity['api'] === 'openai-responses' &&
      identity['baseUrl'] === ZEN_BASE_URL &&
      identity['pricing'] === 'free'
    );
  }
  const cost = record(identity['catalogCost']);
  return (
    identity['api'] === CODEX_API &&
    identity['baseUrl'] === CODEX_BASE_URL &&
    identity['pricing'] === 'provider-account' &&
    identity['catalogSource'] === CODEX_CATALOG &&
    identity['requestedMaxOutputTokens'] === MAX_OUTPUT_TOKENS &&
    identity['maxOutputTokensEnforced'] === false &&
    identity['outputBudgetTransport'] === 'not-sent-by-pi-codex' &&
    typeof identity['providerMaxOutputTokens'] === 'number' &&
    Number.isFinite(identity['providerMaxOutputTokens']) &&
    identity['providerMaxOutputTokens'] >= MAX_OUTPUT_TOKENS &&
    cost !== undefined &&
    validCodexCost({
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
    // The native credential store preserves coordinated OAuth refresh. Never copy tokens
    // into traces or a read-only store that would fail when a run needs a refresh.
    // Ignore user model overrides and keep the fetched model catalog in memory.
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    // Some installations resolve subscription credentials through models.json's
    // apiKey command. Retain that authentication setting while excluding model,
    // endpoint, headers, and transport overrides. Pi resolves it without logging.
    const apiKey = await configuredCodexAuthentication();
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
      throw new Error('No OpenAI Codex credential available');
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
        catalogSource: CODEX_CATALOG,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // Pi 0.84.4's Codex request builder does not serialize maxTokens. Keep
        // the requested cap explicit without claiming that the backend enforces it.
        requestedMaxOutputTokens: MAX_OUTPUT_TOKENS,
        maxOutputTokensEnforced: false,
        providerMaxOutputTokens: catalogModel.maxTokens,
        outputBudgetTransport: 'not-sent-by-pi-codex',
      },
    };
  }
  const { runtime, model } = configured;
  assertSelectedModel(model, requested);
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (actual, context, options) => {
    assertSelectedModel(actual, requested);
    if (options?.reasoning !== requested.thinking)
      throw new Error('Inference refused: reasoning differs from the explicit selection');
    if (
      actual.maxTokens !== MAX_OUTPUT_TOKENS ||
      (options.maxTokens !== undefined && options.maxTokens !== MAX_OUTPUT_TOKENS)
    )
      throw new Error('Inference refused: output budget differs from the frozen limit');
    return stream(actual, context, { ...options, maxTokens: MAX_OUTPUT_TOKENS });
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
