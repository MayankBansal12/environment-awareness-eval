import { z } from 'zod';
import type { RunSandbox } from './sandbox.js';

export const snapshotSchema = z.object({
  digest: z.string(),
  implementationDigest: z.string(),
  commits: z.array(z.string()),
  status: z.string(),
  changedPaths: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const SNAPSHOT_SCRIPT = `
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const files=[]; let visits=0;
function walk(p){if(++visits>5000)throw Error('Workspace file limit exceeded');if(!fs.existsSync(p))return;const st=fs.lstatSync(p);if(st.isSymbolicLink()){files.push([p,fs.readlinkSync(p)]);return;}if(st.isDirectory()){for(const n of fs.readdirSync(p).sort())if(!['.git','node_modules'].includes(n))walk(path.join(p,n));}else if(st.isFile()){if(st.size>2000000)throw Error('Source file limit exceeded');files.push([p,fs.readFileSync(p,'utf8')]);}}
walk('.');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const git=args=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{encoding:'utf8',maxBuffer:1000000}).trim();
const status=git(['status','--porcelain=v1']);
console.log(JSON.stringify({digest:hash(files),implementationDigest:hash(files.filter(([p])=>p.startsWith('src/'))),commits:git(['rev-list',process.argv[1]+'..HEAD']).split('\\n').filter(Boolean),status,changedPaths:git(['diff','--name-only',process.argv[1]]).split('\\n').filter(Boolean)}));
`;

/** Repository digest, commits since the fixture commit, and dirty state, read inside the sandbox. */
export async function repoSnapshot(sandbox: RunSandbox, commit: string): Promise<Snapshot> {
  const result = await sandbox.exec([
    'node',
    '--input-type=module',
    '-e',
    SNAPSHOT_SCRIPT,
    commit,
  ]);
  if (result.exitCode !== 0 || result.truncated)
    throw new Error('Cannot capture repository state: ' + result.stderr);
  return snapshotSchema.parse(JSON.parse(result.stdout));
}
