/**
 * Thin, deterministic Git/exec helpers.
 *
 * Everything the harness runs against a repository goes through here so that the
 * environment (identity, hooks, pagers, locale) is pinned in exactly one place.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Environment used for every harness-side Git invocation. Keeps commits reproducible. */
export const DETERMINISTIC_GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Eval Agent',
  GIT_AUTHOR_EMAIL: 'eval-agent@localhost',
  GIT_COMMITTER_NAME: 'Eval Agent',
  GIT_COMMITTER_EMAIL: 'eval-agent@localhost',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

export async function runCommand(
  file: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string>; maxBuffer?: number },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...DETERMINISTIC_GIT_ENV, ...(options.env ?? {}) },
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    };
  }
}

export async function git(cwd: string, args: readonly string[]): Promise<ExecResult> {
  return runCommand('git', args, { cwd });
}

/** Run a Git command that must succeed; throws with the stderr on failure. */
export async function gitOrThrow(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
