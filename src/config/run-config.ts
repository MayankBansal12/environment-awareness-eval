/**
 * Validated run configuration.
 *
 * Nothing here reaches model context. Credentials are never part of this object: the
 * provider is named, and Pi's own `ModelRuntime` resolves auth from the user's agent
 * directory.
 */

import path from 'node:path';

import { z } from 'zod';

/** The pinned fixture commit for v0. */
export const DEFAULT_FIXTURE_COMMIT = '4437257b659da49a8924f5cbf450d742e1102d14';
export const DEFAULT_FIXTURE_PATH =
  '/home/mayank/code/environment-awareness-ledger-service';

export const thinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ThinkingLevelName = z.infer<typeof thinkingLevelSchema>;

export const runConfigSchema = z.object({
  scenarioId: z.string().min(1),
  fixturePath: z.string().min(1),
  fixtureCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'fixtureCommit must be a full 40-character SHA'),
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: thinkingLevelSchema,
  /** Results directory, always outside the agent workspace. */
  resultsDir: z.string().min(1),
  /** Parent directory for the disposable workspace. Defaults to the OS temp dir. */
  workspaceRoot: z.string().optional(),
  dependencyMode: z.enum(['copy', 'none']),
  /** Hard bounds so a run cannot burn unbounded inference. */
  maxTurns: z.number().int().positive().max(200),
  maxActions: z.number().int().positive().max(1000),
  timeoutMs: z.number().int().positive(),
  /** Keep the disposable workspace after the run for inspection. */
  keepWorkspace: z.boolean(),
  /** Validate configuration and prepare the fixture without any model inference. */
  dryRun: z.boolean(),
  /** Deterministic run identifier used in artifact paths. */
  runId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  /** Skip the post-run hidden behaviour checks (they shell out to vitest). */
  skipHiddenChecks: z.boolean(),
});

export type RunConfig = z.infer<typeof runConfigSchema>;

export interface RunConfigInput {
  scenarioId: string;
  fixturePath?: string;
  fixtureCommit?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  resultsDir?: string;
  workspaceRoot?: string;
  dependencyMode?: string;
  maxTurns?: number;
  maxActions?: number;
  timeoutMs?: number;
  keepWorkspace?: boolean;
  dryRun?: boolean;
  runId?: string;
  skipHiddenChecks?: boolean;
}

export const DEFAULTS = {
  provider: 'openai-codex',
  model: 'gpt-5.6-luna',
  thinkingLevel: 'high' as const,
  resultsDir: 'results',
  dependencyMode: 'copy' as const,
  maxTurns: 40,
  maxActions: 120,
  timeoutMs: 15 * 60 * 1000,
};

export function buildRunConfig(input: RunConfigInput, now: Date = new Date()): RunConfig {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return runConfigSchema.parse({
    scenarioId: input.scenarioId,
    fixturePath: path.resolve(input.fixturePath ?? DEFAULT_FIXTURE_PATH),
    fixtureCommit: input.fixtureCommit ?? DEFAULT_FIXTURE_COMMIT,
    provider: input.provider ?? DEFAULTS.provider,
    model: input.model ?? DEFAULTS.model,
    thinkingLevel: input.thinkingLevel ?? DEFAULTS.thinkingLevel,
    resultsDir: path.resolve(input.resultsDir ?? DEFAULTS.resultsDir),
    ...(input.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: path.resolve(input.workspaceRoot) }),
    dependencyMode: input.dependencyMode ?? DEFAULTS.dependencyMode,
    maxTurns: input.maxTurns ?? DEFAULTS.maxTurns,
    maxActions: input.maxActions ?? DEFAULTS.maxActions,
    timeoutMs: input.timeoutMs ?? DEFAULTS.timeoutMs,
    keepWorkspace: input.keepWorkspace ?? false,
    dryRun: input.dryRun ?? false,
    runId: input.runId ?? input.scenarioId + '-' + stamp,
    skipHiddenChecks: input.skipHiddenChecks ?? false,
  });
}
