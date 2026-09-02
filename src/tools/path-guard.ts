/**
 * Workspace path discipline.
 *
 * This is NOT a security boundary. Pi has no built-in sandbox: the `bash` tool runs
 * arbitrary commands as the host user and can trivially step outside anything enforced
 * here. What this module does provide is:
 *
 * 1. **Path discipline** for the direct file tools (`read`, `edit`, `write`, `grep`,
 *    `find`, `ls`), which keeps accidental drift out of the run and keeps traces
 *    interpretable.
 * 2. **Fixture integrity**, the one guarantee the experiment genuinely depends on: no
 *    command may touch the pinned source fixture repository or the results directory,
 *    because mutating either would invalidate this run and every later one.
 *
 * See docs/limitations.md for what remains reachable and why v0 accepts it.
 */

import path from 'node:path';

export interface GuardDecision {
  block: boolean;
  reason?: string;
  /** Which rule fired, for the trace. */
  rule?: 'workspace_escape' | 'fixture_integrity' | 'results_integrity';
}

const ALLOW: GuardDecision = { block: false };

/** Tools whose `path` argument is confined to the workspace. */
const PATH_TOOLS = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls']);

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface GuardOptions {
  workspacePath: string;
  /** The pinned source fixture repository. Must never be touched by a run. */
  fixturePath: string;
  /** The results directory. Artifacts must not be readable or writable by the agent. */
  resultsDir: string;
}

export function guardToolCall(
  toolName: string,
  input: Record<string, unknown>,
  options: GuardOptions,
): GuardDecision {
  if (PATH_TOOLS.has(toolName)) {
    const raw = input['path'];
    if (typeof raw === 'string' && raw.length > 0) {
      const resolved = path.resolve(options.workspacePath, raw);
      const protectedDecision = protectedPathDecision(resolved, options);
      if (protectedDecision !== undefined) return protectedDecision;
      if (!isInside(options.workspacePath, resolved)) {
        return {
          block: true,
          rule: 'workspace_escape',
          reason:
            'Path ' +
            raw +
            ' resolves outside the current workspace. Work only inside the current working directory.',
        };
      }
    }
    return ALLOW;
  }

  if (toolName === 'bash' || toolName === 'powershell') {
    const command = input['command'];
    if (typeof command !== 'string') return ALLOW;
    return guardCommandText(command, options);
  }

  return ALLOW;
}

function protectedPathDecision(
  resolved: string,
  options: GuardOptions,
): GuardDecision | undefined {
  if (isInside(options.fixturePath, resolved)) {
    return {
      block: true,
      rule: 'fixture_integrity',
      reason: 'That path is outside the current workspace and is not available.',
    };
  }
  if (isInside(options.resultsDir, resolved)) {
    return {
      block: true,
      rule: 'results_integrity',
      reason: 'That path is outside the current workspace and is not available.',
    };
  }
  return undefined;
}

/**
 * Fixture-integrity screen for shell commands.
 *
 * Deliberately narrow: it only looks for the two absolute paths whose contents the
 * experiment depends on. It is not an attempt to sandbox the shell, and it is not
 * reachable through the prompt, which never names either path.
 */
export function guardCommandText(command: string, options: GuardOptions): GuardDecision {
  const targets: Array<[string, NonNullable<GuardDecision['rule']>]> = [
    [options.fixturePath, 'fixture_integrity'],
    [options.resultsDir, 'results_integrity'],
  ];
  for (const [target, rule] of targets) {
    if (target.length > 0 && command.includes(target)) {
      return {
        block: true,
        rule,
        reason:
          'That path is outside the current workspace and is not available. Work only inside the current working directory.',
      };
    }
  }
  return ALLOW;
}
