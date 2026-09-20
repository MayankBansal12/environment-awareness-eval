/** Publish a selected, privacy-filtered viewer projection without altering original evidence. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadRun, rowOf } from './build-data.js';
import type { RunDetail, ViewerIndex } from '../src/model.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const hash = (s: Buffer | string) => createHash('sha256').update(s).digest('hex');
const selection = JSON.parse(
  await readFile(path.join(root, 'datasets/v1/selection.json'), 'utf8'),
) as {
  included: Array<{ path: string; summarySha256: string }>;
};
const out = path.resolve(process.argv[2] ?? path.join(root, 'results/publish-v1'));
await mkdir(out, { recursive: true });
const index: ViewerIndex = {
  generatedAt: new Date().toISOString(),
  resultsDir: 'Dataset v1 · curated, normally completed sessions',
  runs: [],
  experiments: [],
  skipped: [],
};
const runs: RunDetail[] = [];
for (const selected of selection.included) {
  const dir = path.join(root, selected.path);
  if (hash(await readFile(path.join(dir, 'summary.json'))) !== selected.summarySha256)
    throw Error('Selected evidence changed: ' + selected.path);
  const key = selected.path.replace(/^results\//, '');
  const run = await loadRun(dir, key);
  if (
    !run.summary.grade.valid ||
    run.summary.grade.censored ||
    run.summary.termination.reason !== 'agent_finished'
  )
    throw Error('Ineligible published session: ' + key);
  // Preserve observable task text and reasoning. Only replace host-private paths in
  // the exported projection. Native wire logs and credential metadata are not included.
  const clean = JSON.parse(
    JSON.stringify(run).replaceAll('/home/mayank', '[host-home]'),
  ) as RunDetail;
  runs.push(clean);
  index.runs.push(rowOf(clean, null));
}
const archive = gzipSync(JSON.stringify({ version: 1, index, runs }), { level: 9 });
const file = 'viewer-dataset-v1.json.gz';
await writeFile(path.join(out, file), archive);
const descriptor = {
  version: 1,
  repository: 'MayankBansal12/environment-awareness-eval',
  release: 'dataset-v1',
  asset: file,
  sha256: hash(archive),
  bytes: archive.length,
  sessions: runs.length,
};
await writeFile(
  path.join(root, 'datasets/v1/dataset.json'),
  JSON.stringify(descriptor, null, 2) + '\n',
);
console.log(JSON.stringify(descriptor));
