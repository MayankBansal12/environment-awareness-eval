import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Pin actual local source including uncommitted changes; a Git HEAD alone is insufficient. */
export async function sourceIdentity(): Promise<Record<string, string>> {
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(path.join(PROJECT_ROOT, dir), {
      withFileTypes: true,
    })) {
      const name = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (name.endsWith('.ts')) files.push(name);
    }
  }
  await walk('src');
  files.push('package.json', 'pnpm-lock.yaml');
  const hashes: Record<string, string> = {};
  for (const name of files.sort())
    hashes[name] = sha256(await readFile(path.join(PROJECT_ROOT, name)));
  return hashes;
}
