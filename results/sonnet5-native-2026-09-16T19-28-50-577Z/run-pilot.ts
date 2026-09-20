import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { run, DEFAULT_BUDGETS } from '../../src/runner.js';
import { selectModel } from '../../src/harness/model.js';
import { sourceIdentity } from '../../src/harness/identity.js';

const id = 'sonnet5-native-' + new Date().toISOString().replace(/[:.]/g, '-');
const root = path.resolve('results', id);
await mkdir(root);
const modelConfig = selectModel({ provider: 'anthropic', model: 'claude-sonnet-5' });
const sources = await sourceIdentity();
const files = Object.fromEntries(await Promise.all(Object.keys(sources).map(async (p) => [p, await readFile(p, 'utf8')])));
await writeFile(path.join(root, 'sources.json.gz'), gzipSync(JSON.stringify({ sources, files })));
await writeFile(path.join(root, 'pilot-plan.json'), JSON.stringify({
  id, gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  modelConfig, budgets: DEFAULT_BUDGETS, conditions: ['settlement', 'fulfillment'].map((family) => ({ family, load: 'high', noise: 'normal', delivery: 'ambient', seed: 1 })),
  sources, note: 'Exploratory pilot: one fresh native Claude Code session per family; not a model comparison.'
}, null, 2) + '\n');
console.log('PILOT_ROOT=' + root);
for (const family of ['settlement', 'fulfillment'] as const) {
  const summary = await run({ runId: family, resultsDir: root, condition: { family, load: 'high', noise: 'normal', delivery: 'ambient', seed: 1 }, budgets: DEFAULT_BUDGETS, keepWorkspace: false, modelConfig, expectedSources: sources });
  console.log(JSON.stringify({ family, termination: summary.termination, grade: summary.grade, usage: summary.usage }));
  if (['provider_error', 'harness_error'].includes(summary.termination.reason)) {
    console.log('Pilot paused after infrastructure/provider error; remaining case not launched.');
    process.exitCode = 1;
    break;
  }
}
