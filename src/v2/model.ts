import {
  ModelRuntime,
  readStoredCredential,
  type CreateModelRuntimeOptions,
} from '@earendil-works/pi-coding-agent';

export const FREE_MODEL = 'muse-spark-1.3-contributor-free';
export const FREE_PROVIDER = 'opencode';
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

export function assertFreeModel(model: {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): void {
  if (
    model.id !== FREE_MODEL ||
    model.provider !== FREE_PROVIDER ||
    model.api !== 'openai-responses' ||
    model.baseUrl !== ZEN_BASE_URL ||
    Object.values(model.cost).some((n) => n !== 0)
  )
    throw new Error(
      'Inference refused: only the verified free Muse Spark 1.3 model on OpenCode ZEN is authorized',
    );
}

export async function freeRuntime(verifyOnline = true) {
  // Read the existing key once without auth-file locks or writes. Never expose its value.
  const credential = readStoredCredential(FREE_PROVIDER);
  const credentials: NonNullable<CreateModelRuntimeOptions['credentials']> = {
    read: async (provider) => (provider === FREE_PROVIDER ? credential : undefined),
    list: async () => [],
    modify: async () => {
      throw new Error('Credential mutation is disabled');
    },
    delete: async () => {
      throw new Error('Credential mutation is disabled');
    },
  };
  if (verifyOnline) {
    const response = await fetch(`${ZEN_BASE_URL}/models`, {
      signal: AbortSignal.timeout(15000),
    });
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    if (!response.ok || !body.data?.some((m) => m.id === FREE_MODEL))
      throw new Error(
        'Free model is not available in the ZEN catalog; no fallback permitted',
      );
    const pricing = await fetch('https://opencode.ai/docs/zen/', {
      signal: AbortSignal.timeout(15000),
    });
    const html = await pricing.text();
    const row = html
      .match(/<tr[^>]*>\s*<td[^>]*>Muse Spark 1\.3 Contributor Free<\/td>[\s\S]*?<\/tr>/g)
      ?.find((r) => /<td>Free<\/td>/.test(r));
    if (!pricing.ok || !row || (row.match(/>Free<\/td>/g)?.length ?? 0) < 3)
      throw new Error('Could not verify current free pricing; no inference permitted');
  }
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider(FREE_PROVIDER, {
    baseUrl: ZEN_BASE_URL,
    api: 'openai-responses',
    authHeader: true,
    models: [
      {
        id: FREE_MODEL,
        name: 'Muse Spark 1.3 Contributor Free',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
  });
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel(FREE_PROVIDER, FREE_MODEL);
  if (!model) throw new Error('Could not register the authorized free model');
  assertFreeModel(model);
  if (!(await runtime.checkAuth(FREE_PROVIDER)))
    throw new Error('No OpenCode ZEN credential available');
  // Protect each model call, including any runtime-internal retry, from model substitution.
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (requested, context, options) => {
    assertFreeModel(requested);
    return stream(requested, context, options);
  };
  return {
    runtime,
    model,
    verification: {
      provider: FREE_PROVIDER,
      model: FREE_MODEL,
      api: 'openai-responses',
      baseUrl: ZEN_BASE_URL,
      pricing: 'free',
      verifiedAt: new Date().toISOString(),
      pricingSource: 'https://opencode.ai/docs/zen/',
      catalogSource: `${ZEN_BASE_URL}/models`,
      maxOutputTokens: 8192,
    },
  };
}
