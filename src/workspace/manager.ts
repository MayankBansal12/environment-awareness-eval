/**
 * Disposable workspace lifecycle.
 *
 * Invariants this module enforces:
 *
 * - The source fixture repository is read only. It is cloned with `--no-hardlinks`, its
 *   HEAD is verified against the configured commit, and the harness never writes to it.
 * - Every run starts from that exact commit in a fresh directory outside the results tree.
 * - The clone has no remotes, so a `git push` from inside the run cannot reach anything.
 * - Git identity is pinned locally so commit hashes do not depend on the host user.
 * - Dependencies are copied (not symlinked) into the workspace, so the run is offline,
 *   fast, and cannot reach back into the fixture's `node_modules`.
 */

import { cp, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { git, gitOrThrow, runCommand } from './git.js';

export interface FixtureVerification {
  sourcePath: string;
  headCommit: string;
  expectedCommit: string;
  matchesExpected: boolean;
  sourceWorkingTreeClean: boolean;
}

export interface PreparedWorkspace {
  path: string;
  headCommit: string;
  branch: string;
  fixture: FixtureVerification;
  dependenciesInstalled: boolean;
}

export type DependencyMode = 'copy' | 'none';

const WORK_BRANCH = 'eval-work';

export async function verifyFixture(
  sourcePath: string,
  expectedCommit: string,
): Promise<FixtureVerification> {
  const resolved = path.resolve(sourcePath);
  try {
    await stat(path.join(resolved, '.git'));
  } catch {
    throw new Error(`fixture path is not a Git repository: ${resolved}`);
  }
  const headCommit = (await gitOrThrow(resolved, ['rev-parse', 'HEAD'])).trim();
  const status = (await git(resolved, ['status', '--porcelain=v1'])).stdout.trim();
  return {
    sourcePath: resolved,
    headCommit,
    expectedCommit,
    matchesExpected: headCommit === expectedCommit,
    sourceWorkingTreeClean: status.length === 0,
  };
}

export async function prepareWorkspace(options: {
  sourcePath: string;
  expectedCommit: string;
  runId: string;
  /** Parent directory for the disposable checkout. Defaults to the OS temp dir. */
  rootDir?: string;
  dependencyMode?: DependencyMode;
}): Promise<PreparedWorkspace> {
  const fixture = await verifyFixture(options.sourcePath, options.expectedCommit);
  if (!fixture.matchesExpected) {
    throw new Error(
      'fixture integrity check failed: ' +
        options.sourcePath +
        ' is at ' +
        fixture.headCommit +
        ' but the run is pinned to ' +
        options.expectedCommit,
    );
  }

  const parent = options.rootDir ?? os.tmpdir();
  // Run identifiers often name the intervention. Never expose them in the agent's cwd.
  const base = await mkdtemp(path.join(parent, 'eaw-run-'));
  const workspacePath = path.join(base, 'workspace');

  const clone = await runCommand(
    'git',
    ['clone', '--no-hardlinks', '--quiet', fixture.sourcePath, workspacePath],
    { cwd: parent },
  );
  if (clone.exitCode !== 0) {
    throw new Error('failed to clone fixture: ' + clone.stderr.trim());
  }

  await gitOrThrow(workspacePath, [
    'checkout',
    '--quiet',
    '-B',
    WORK_BRANCH,
    options.expectedCommit,
  ]);
  // Remove the only handle back to the fixture repository.
  await git(workspacePath, ['remote', 'remove', 'origin']);
  // Pin identity locally so the run never depends on host Git config.
  await gitOrThrow(workspacePath, ['config', 'user.name', 'Eval Agent']);
  await gitOrThrow(workspacePath, ['config', 'user.email', 'eval-agent@localhost']);
  await gitOrThrow(workspacePath, ['config', 'commit.gpgsign', 'false']);
  await gitOrThrow(workspacePath, [
    'config',
    'core.hooksPath',
    path.join(base, 'no-hooks'),
  ]);

  const dependencyMode = options.dependencyMode ?? 'copy';
  const dependenciesInstalled = await provisionDependencies(
    fixture.sourcePath,
    workspacePath,
    dependencyMode,
  );

  const headCommit = (await gitOrThrow(workspacePath, ['rev-parse', 'HEAD'])).trim();
  if (headCommit !== options.expectedCommit) {
    throw new Error(
      'prepared workspace HEAD ' + headCommit + ' does not match ' + options.expectedCommit,
    );
  }

  return {
    path: workspacePath,
    headCommit,
    branch: WORK_BRANCH,
    fixture,
    dependenciesInstalled,
  };
}

async function provisionDependencies(
  sourcePath: string,
  workspacePath: string,
  mode: DependencyMode,
): Promise<boolean> {
  if (mode === 'none') return false;
  const sourceModules = path.join(sourcePath, 'node_modules');
  try {
    await stat(sourceModules);
  } catch {
    return false;
  }
  const target = path.join(workspacePath, 'node_modules');
  // pnpm's tree is a farm of *relative* symlinks into `.pnpm`, so a plain recursive copy
  // yields a self-contained tree that resolves entirely inside the workspace.
  await cp(sourceModules, target, { recursive: true, verbatimSymlinks: true });
  return true;
}

/** Write a marker so a retained workspace is obviously disposable. */
export async function writeRetentionMarker(
  workspacePath: string,
  runId: string,
): Promise<void> {
  await writeFile(
    path.join(path.dirname(workspacePath), 'RETAINED-BY-EVAL.txt'),
    'Disposable eval workspace retained for debugging.\nRun id: ' + runId + '\n',
    'utf8',
  );
}

export async function disposeWorkspace(workspacePath: string): Promise<void> {
  // The workspace always lives one level below its own mkdtemp base.
  const base = path.dirname(workspacePath);
  if (!path.basename(base).startsWith('eaw-run-')) {
    throw new Error('refusing to remove unexpected workspace root: ' + base);
  }
  await rm(base, { recursive: true, force: true });
}
