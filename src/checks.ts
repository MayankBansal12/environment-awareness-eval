import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AGENT_CWD, type RunSandbox } from './harness/sandbox.js';
import type { Check, SpecFlags, TaskFamily } from './families/types.js';

export interface ProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}
/** Runs a trusted probe script against a repository root. */
export interface ProbeExecutor {
  root: string;
  run(script: string): Promise<ProbeResult>;
}
export interface TaskChecks {
  focal: Check[];
  hotfix: Check[];
}

export function sandboxExecutor(sandbox: RunSandbox): ProbeExecutor {
  return {
    root: AGENT_CWD,
    run: (script) =>
      sandbox.exec(['node', '--input-type=module', '-e', script], { readOnly: true }),
  };
}

/** Unsandboxed executor for calibrating trusted reference code only; never for agent output. */
export function directExecutor(root: string): ProbeExecutor {
  return {
    root,
    run: (script) =>
      new Promise((resolve) => {
        execFile(
          existsSync('/usr/bin/node') ? '/usr/bin/node' : process.execPath,
          ['--input-type=module', '-e', script],
          { cwd: root, timeout: 30_000, maxBuffer: 1_000_000 },
          (error, stdout, stderr) =>
            resolve({
              stdout,
              stderr,
              exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
              truncated: false,
            }),
        );
      }),
  };
}

export async function probe(
  executor: ProbeExecutor,
  script: string,
  ids: string[],
): Promise<Check[]> {
  const out = await executor.run(script.replaceAll('__REPO__', executor.root));
  const fail = (detail: string) => ids.map((id) => ({ id, passed: false, detail }));
  if (out.exitCode !== 0 || out.truncated)
    return fail(('probe failed: ' + out.stderr).slice(0, 500));
  try {
    const line = out.stdout.trim().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(line) as Check[];
    const byId = new Map(parsed.map((c) => [c.id, c]));
    return ids.map((id) => byId.get(id) ?? { id, passed: false, detail: 'missing check' });
  } catch {
    return fail('unreadable probe output');
  }
}

export async function taskChecks(
  executor: ProbeExecutor,
  family: TaskFamily,
  spec: SpecFlags,
): Promise<TaskChecks> {
  return {
    focal: await probe(executor, family.focalProbe(spec), family.checkIds.focal),
    hotfix: await probe(executor, family.hotfixProbe(), family.checkIds.hotfix),
  };
}
