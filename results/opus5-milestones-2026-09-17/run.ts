import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { run, DEFAULT_BUDGETS } from '../../src/runner.js';
import { selectModel } from '../../src/harness/model.js';
import { sourceIdentity } from '../../src/harness/identity.js';
const root = path.resolve('results/opus5-milestones-2026-09-17');
await mkdir(root, { recursive: true });
const sources = await sourceIdentity();
try {
  const previous = JSON.parse(await readFile(path.join(root, 'plan.json'), 'utf8'));
  if (JSON.stringify(previous.sources) !== JSON.stringify(sources))
    throw Error('Existing pilot source mismatch; choose a fresh results directory');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const trials = [];
for (let rep = 1; rep <= 3; rep++) {
  for (const model of ['claude-opus-5']) {
    for (const family of ['settlement', 'fulfillment'] as const) {
      trials.push({ id: `${model}-${family}-r${rep}`, model, family, rep, seed: rep,
        reused: null });
    }
  }
}
await writeFile(path.join(root, 'plan.json'), JSON.stringify({ trials, sources, budgets: DEFAULT_BUDGETS,
  note: 'script-3.0 native Claude Code Opus 5, default effort, high/normal/ambient; seeds 1,2,3. Six fresh sessions. Compare timing descriptively with script-2.0; historical Sonnet is not a matched-condition comparison.' }, null, 2));
const files = Object.fromEntries(await Promise.all(Object.keys(sources).map(async p => [p, await readFile(p, 'utf8')])));
await writeFile(path.join(root, 'sources.json.gz'), gzipSync(JSON.stringify({ sources, files })));
const records = [];
for (const trial of trials) {
  const attemptId = trial.id;
  const dir = trial.reused ?? path.join(root, attemptId);
  let summary;
  try { summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (!summary) {
    console.log('START', trial.id);
    summary = await run({ runId: attemptId, resultsDir: root,
      condition: { family: trial.family, load: 'high', noise: 'normal', delivery: 'ambient', seed: trial.seed },
      budgets: DEFAULT_BUDGETS, keepWorkspace: false,
      modelConfig: selectModel({ provider: 'anthropic', model: trial.model }), expectedSources: sources });
  }
  const record = { ...trial, dir, termination: summary.termination, valid: summary.grade.valid,
    censored: summary.grade.censored, events: summary.grade.events, outcome: summary.grade.outcome, usage: summary.usage };
  records.push(record);
  await writeFile(path.join(root, 'progress.json'), JSON.stringify(records, null, 2));
  console.log('FINISH', trial.id, JSON.stringify({ termination: record.termination, valid: record.valid, outcome: record.outcome }));
  if (['provider_error', 'harness_error'].includes(summary.termination.reason)) {
    console.log('STOP: provider/harness failure; no further inference launched.'); process.exitCode = 1; break;
  }
}
