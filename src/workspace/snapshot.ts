/**
 * Workspace/Git snapshots.
 *
 * Source mutation is detected from Git state rather than from which tool the model used,
 * so a `bash` heredoc write counts exactly like an `edit` call. Snapshots are taken at
 * decision boundaries and are the sole evidence for semantic triggers.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { git } from './git.js';

/** Paths whose contents constitute "the agent's work" for mutation detection. */
export const DEFAULT_WATCHED_PATHS: readonly string[] = ['src', 'tests'];

/** Field separator for `git log --format=%x1f`; cannot appear in a commit subject. */
const UNIT_SEPARATOR = '\u001f';

export interface CommitRecord {
  hash: string;
  subject: string;
  /** Committer timestamp; diagnostic only. */
  unixTime: number;
}

export interface WorkspaceSnapshot {
  headCommit: string;
  /** Commits on HEAD that are not reachable from the pinned fixture commit. */
  commitsAheadOfFixture: number;
  commits: CommitRecord[];
  /** True once anything under the watched paths differs from the fixture commit. */
  sourceMutated: boolean;
  workingTreeDirty: boolean;
  /** `git status --porcelain` over the whole repo. */
  statusPorcelain: string;
  /** Stable digest of watched-path content relative to the fixture commit. */
  trackedSourceDigest: string;
  /** Files changed under watched paths relative to the fixture commit. */
  changedWatchedFiles: string[];
  /** Untracked files under watched paths. */
  untrackedWatchedFiles: string[];
}

function parseStatus(porcelain: string): Array<{ code: string; file: string }> {
  return porcelain
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ code: line.slice(0, 2), file: line.slice(3).trim() }));
}

function isUnderWatched(file: string, watched: readonly string[]): boolean {
  const normalized = file.replace(/^"|"$/g, '');
  return watched.some((dir) => normalized === dir || normalized.startsWith(dir + '/'));
}

export async function takeSnapshot(
  workspacePath: string,
  fixtureCommit: string,
  watchedPaths: readonly string[] = DEFAULT_WATCHED_PATHS,
): Promise<WorkspaceSnapshot> {
  const head = (await git(workspacePath, ['rev-parse', 'HEAD'])).stdout.trim();
  const statusPorcelain = (await git(workspacePath, ['status', '--porcelain=v1', '-uall']))
    .stdout;
  const entries = parseStatus(statusPorcelain);

  const aheadRaw = (
    await git(workspacePath, ['rev-list', '--count', fixtureCommit + '..HEAD'])
  ).stdout.trim();
  const commitsAheadOfFixture = Number.parseInt(aheadRaw, 10);

  const logRaw = (
    await git(workspacePath, ['log', '--format=%H%x1f%ct%x1f%s', fixtureCommit + '..HEAD'])
  ).stdout;
  const commits: CommitRecord[] = logRaw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash = '', unixTime = '0', subject = ''] = line.split(UNIT_SEPARATOR);
      return { hash, unixTime: Number.parseInt(unixTime, 10), subject };
    });

  // `git diff <commit> -- paths` compares the *working tree* against that commit, so it
  // covers both committed and uncommitted changes to tracked files in one call.
  const diffVsFixture = (
    await git(workspacePath, ['diff', fixtureCommit, '--', ...watchedPaths])
  ).stdout;
  const changedWatchedFiles = (
    await git(workspacePath, ['diff', '--name-only', fixtureCommit, '--', ...watchedPaths])
  ).stdout
    .split('\n')
    .filter((line) => line.trim().length > 0);

  const untrackedWatchedFiles = entries
    .filter((entry) => entry.code === '??' && isUnderWatched(entry.file, watchedPaths))
    .map((entry) => entry.file)
    .sort();

  const hash = createHash('sha256');
  hash.update(diffVsFixture);
  for (const file of untrackedWatchedFiles) {
    hash.update(' untracked:' + file + ' ');
    try {
      hash.update(await readFile(path.join(workspacePath, file)));
    } catch {
      hash.update('<unreadable>');
    }
  }

  return {
    headCommit: head,
    commitsAheadOfFixture: Number.isNaN(commitsAheadOfFixture) ? 0 : commitsAheadOfFixture,
    commits,
    sourceMutated: changedWatchedFiles.length > 0 || untrackedWatchedFiles.length > 0,
    workingTreeDirty: entries.length > 0,
    statusPorcelain,
    trackedSourceDigest: hash.digest('hex'),
    changedWatchedFiles,
    untrackedWatchedFiles,
  };
}

/** Full unified diff against the fixture commit, for the final artifact bundle. */
export async function fullDiffVsFixture(
  workspacePath: string,
  fixtureCommit: string,
): Promise<string> {
  return (await git(workspacePath, ['diff', fixtureCommit])).stdout;
}
