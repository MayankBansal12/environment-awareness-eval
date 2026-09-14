import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './harness/identity.js';
import type { Load, TaskFamily } from './families/types.js';

export async function putFiles(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

export function fixtureDigest(family: TaskFamily, load: Load) {
  return sha256(JSON.stringify(family.files(load)));
}

export const INIT_REPO =
  'git init -q -b main && git config user.name Engineer && git config user.email engineer@localhost && git config commit.gpgsign false && git config core.hooksPath /dev/null && git add . && GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z git commit -qm "Initial import" && git rev-parse HEAD';
