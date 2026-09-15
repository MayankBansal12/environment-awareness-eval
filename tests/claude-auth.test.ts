import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createClaudeRuntime, readClaudeCredential } from '../src/harness/claude-auth.js';

vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual('node:fs/promises')),
  readFile: vi.fn(),
}));
const token = 'sk-ant-oat-fake-test-only';
const valid = {
  accessToken: token,
  expiresAt: Date.now() + 3600_000,
  scopes: ['user:inference'],
};
beforeEach(() =>
  vi
    .mocked(readFile)
    .mockReset()
    .mockResolvedValue(JSON.stringify({ claudeAiOauth: valid })),
);
afterEach(() => vi.restoreAllMocks());

it('reads existing Claude OAuth without copying or exposing it in errors', async () => {
  expect(await readClaudeCredential()).toEqual({ type: 'api_key', key: token });
  for (const value of [
    { ...valid, expiresAt: Date.now() + 60_000 },
    { ...valid, expiresAt: 'later' },
    { ...valid, scopes: [] },
    { ...valid, accessToken: 'wrong-kind' },
    null,
  ]) {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ claudeAiOauth: value }));
    await expect(readClaudeCredential()).rejects.toThrow('No valid Claude Code');
  }
  vi.mocked(readFile).mockRejectedValue(new Error(token));
  await expect(readClaudeCredential()).rejects.not.toThrow(token);
  vi.mocked(readFile).mockResolvedValue(token);
  await expect(readClaudeCredential()).rejects.not.toThrow(token);
});

it('prefers native Pi authentication and leaves coordinated native refresh intact', async () => {
  const native = {
    checkAuth: vi.fn(async () => ({ type: 'oauth' })),
  } as unknown as ModelRuntime;
  const create = vi.spyOn(ModelRuntime, 'create').mockResolvedValue(native);
  expect(await createClaudeRuntime()).toEqual({ runtime: native, authSource: 'native-pi' });
  expect(create).toHaveBeenCalledOnce();
  expect(readFile).not.toHaveBeenCalled();
});

it('re-reads Claude credentials at every resolution, refuses expiry and cannot modify the CLI store', async () => {
  const native = { checkAuth: vi.fn(async () => undefined) } as unknown as ModelRuntime;
  const create = vi.spyOn(ModelRuntime, 'create').mockResolvedValue(native);
  expect((await createClaudeRuntime()).authSource).toBe('claude-code-read-only');
  const store = create.mock.calls[1]![0]!.credentials!;
  expect(await store.read('anthropic')).toEqual({ type: 'api_key', key: token });
  vi.mocked(readFile).mockResolvedValue(
    JSON.stringify({ claudeAiOauth: { ...valid, accessToken: token + '-rotated' } }),
  );
  expect(await store.read('anthropic')).toEqual({
    type: 'api_key',
    key: token + '-rotated',
  });
  vi.mocked(readFile).mockResolvedValue(
    JSON.stringify({ claudeAiOauth: { ...valid, expiresAt: 1 } }),
  );
  await expect(store.read('anthropic')).rejects.toThrow('No valid Claude Code');
  expect(await store.read('other')).toBeUndefined();
  await expect(store.delete('anthropic')).rejects.toThrow('read-only');
});
