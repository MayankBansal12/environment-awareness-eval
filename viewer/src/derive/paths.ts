/**
 * Workspace paths point into a disposable `/tmp/eaw-run-<id>-XXXX/workspace` clone that no
 * longer exists. Rendering them in full buries the repo-relative part that a reader
 * actually needs, so the prefix is stripped everywhere it appears.
 */

/** `.` denotes the workspace root itself; render it as such rather than as an empty string. */
const ROOT_LABEL = '.';

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Strips `workspacePath` (and any trailing slash) from the front of `value`.
 * Values that are already repo-relative are returned unchanged.
 */
export function stripWorkspacePrefix(
  value: string,
  workspacePath: string | null | undefined,
): string {
  const path = normalizeSeparators(value.trim());
  if (path === '') return path;
  if (workspacePath === null || workspacePath === undefined || workspacePath === '') {
    return path;
  }
  const prefix = normalizeSeparators(workspacePath).replace(/\/+$/, '');
  if (path === prefix) return ROOT_LABEL;
  if (path.startsWith(prefix + '/')) {
    const rest = path.slice(prefix.length + 1);
    return rest === '' ? ROOT_LABEL : rest;
  }
  return path;
}

/**
 * Strips every occurrence of the workspace path from a block of free text — command
 * output, a diff, a test report. Used so `/tmp/eaw-run-…/workspace/src/x.ts` in a vitest
 * header reads as `src/x.ts`.
 */
export function stripWorkspacePrefixEverywhere(
  text: string,
  workspacePath: string | null | undefined,
): string {
  if (workspacePath === null || workspacePath === undefined || workspacePath === '') {
    return text;
  }
  const prefix = normalizeSeparators(workspacePath).replace(/\/+$/, '');
  if (prefix === '') return text;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A trailing slash is consumed with the prefix so `<prefix>/src` becomes `src`, while a
  // bare `<prefix>` becomes `.`.
  return text
    .replace(new RegExp(escaped + '/', 'g'), '')
    .replace(new RegExp(escaped, 'g'), ROOT_LABEL);
}

/** The last segment, for dense timeline rows where the directory is noise. */
export function basename(path: string): string {
  const normalized = normalizeSeparators(path).replace(/\/+$/, '');
  if (normalized === '' || normalized === ROOT_LABEL) return ROOT_LABEL;
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** The directory portion, used to summarise a band that touched many files in one tree. */
export function dirname(path: string): string {
  const normalized = normalizeSeparators(path).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? ROOT_LABEL : normalized.slice(0, index);
}
