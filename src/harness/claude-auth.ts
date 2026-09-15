import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Read-only bridge: Claude Code owns login/refresh; no credential is copied to artifacts. */
export async function readClaudeCredential() {
  try {
    const file = path.join(
      process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'),
      '.credentials.json',
    );
    const value = JSON.parse(await readFile(file, 'utf8')).claudeAiOauth;
    if (
      typeof value?.accessToken !== 'string' ||
      !value.accessToken.startsWith('sk-ant-oat') ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() + 5 * 60_000 ||
      !Array.isArray(value.scopes) ||
      !value.scopes.includes('user:inference')
    )
      throw new Error();
    return { type: 'api_key' as const, key: value.accessToken };
  } catch {
    throw new Error(
      'No valid Claude Code inference credential; refresh Claude Code login or configure native Pi Anthropic authentication',
    );
  }
}

export async function createClaudeRuntime() {
  const options = { modelsPath: null, refreshOnCreate: false } as const;
  const native = await ModelRuntime.create(options);
  if (await native.checkAuth('anthropic'))
    return { runtime: native, authSource: 'native-pi' };
  await readClaudeCredential();
  const runtime = await ModelRuntime.create({
    ...options,
    credentials: {
      // Resolve afresh for every request, including compaction. Claude Code owns refresh.
      read: async (provider) =>
        provider === 'anthropic' ? readClaudeCredential() : undefined,
      list: async () => [{ providerId: 'anthropic', type: 'api_key' }],
      modify: async () => {
        throw new Error('Claude Code credential bridge is read-only');
      },
      delete: async () => {
        throw new Error('Claude Code credential bridge is read-only');
      },
    },
  });
  return { runtime, authSource: 'claude-code-read-only' };
}
