/**
 * Reads a v4 results tree and writes `public/data/index.json` plus one `runs/<key>.json` per
 * run for the viewer to fetch.
 *
 *   tsx scripts/build-data.ts [--results <dir>]   (or EAW_RESULTS_DIR; default <repo>/results)
 *
 * Experiments are `<id>/manifest.json` with `runs/<run>/`; ad hoc runs are any other directory
 * holding a v4 `summary.json`. Anything else is listed as skipped, never fatal.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema, type Comparison } from '../../src/experiment.js';
import type { CapturedMessage } from '../../src/harness/capture.js';
import { contextSchema, FORMAT, type Event, type Summary } from '../../src/schema.js';
import type { ExperimentEntry, RunDetail, RunRow, ViewerIndex } from '../src/model.js';

const viewerRoot = fileURLToPath(new URL('..', import.meta.url));

const readIfPresent = (file: string) => readFile(file, 'utf8').catch(() => null);
const jsonl = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);

export async function loadRun(dir: string, key: string): Promise<RunDetail> {
  const summaryText = await readIfPresent(path.join(dir, 'summary.json'));
  if (summaryText === null) throw Error('summary.json is missing');
  const summary = JSON.parse(summaryText) as Summary;
  if (summary.format !== FORMAT) throw Error(`format ${String(summary.format)} is not v4`);
  const trace = jsonl(await readFile(path.join(dir, 'trace.jsonl'), 'utf8')) as Event[];
  trace.forEach((e, i) => {
    if (e.format !== FORMAT || e.seq !== i + 1)
      throw Error(`trace.jsonl:${i + 1} malformed`);
  });
  const run: RunDetail = {
    key,
    summary,
    trace,
    header: null,
    capture: null,
    messages: [],
    inputs: {},
    outputs: {},
  };
  const interned = new Map<string, number>();
  const intern = (m: CapturedMessage) => {
    const text = JSON.stringify(m);
    let i = interned.get(text);
    if (i === undefined) {
      i = run.messages.push(m) - 1;
      interned.set(text, i);
    }
    return i;
  };
  for (const line of jsonl((await readIfPresent(path.join(dir, 'context.jsonl'))) ?? '')) {
    const c = contextSchema.parse(line);
    if (c.type === 'header') run.header = c;
    else if (c.type === 'audit') run.capture = c;
    else if (c.type === 'input') run.inputs[c.decision] = c.messages.map(intern);
    else run.outputs[c.decision] = c.message;
  }
  return run;
}

export function rowOf(run: RunDetail, experiment: string | null): RunRow {
  const s = run.summary;
  return {
    key: run.key,
    runId: s.runId,
    experiment,
    condition: s.condition,
    model: [s.runtime['model'], s.runtime['thinking']].filter(Boolean).join(' · '),
    termination: s.termination.reason,
    valid: s.grade.valid,
    censored: s.grade.censored,
    decisions: s.usage.turnCalls,
    totalTokens: s.usage.totalTokens,
    costUsd: s.usage.costUsd.total,
    durationMs: s.durationMs,
    importantFired: s.grade.summary['importantFired'] ?? 0,
    importantMissed: s.grade.summary['importantMissed'] ?? 0,
  };
}

export async function loadResults(resultsDir: string) {
  const index: ViewerIndex = {
    generatedAt: new Date().toISOString(),
    resultsDir,
    runs: [],
    experiments: [],
    skipped: [],
  };
  const details: RunDetail[] = [];
  const isDir = (p: string) =>
    stat(p)
      .then((s) => s.isDirectory())
      .catch(() => false);
  const tryRun = async (dir: string, experiment: string | null) => {
    const key = path.relative(resultsDir, dir).split(path.sep).join('/');
    try {
      const run = await loadRun(dir, key);
      details.push(run);
      index.runs.push(rowOf(run, experiment));
    } catch (e) {
      index.skipped.push({ path: key, reason: e instanceof Error ? e.message : String(e) });
    }
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    const manifestText = await readIfPresent(path.join(dir, 'manifest.json'));
    if (manifestText !== null) {
      const key = path.relative(resultsDir, dir);
      const parsed = manifestSchema.safeParse(JSON.parse(manifestText));
      if (!parsed.success) {
        index.skipped.push({ path: key, reason: 'manifest.json is not a v4 manifest' });
        return;
      }
      const comparison = await readIfPresent(path.join(dir, 'comparison.json'));
      if (comparison !== null)
        index.experiments.push({
          id: parsed.data.id,
          profile: parsed.data.design.profile,
          createdAt: parsed.data.createdAt,
          comparison: JSON.parse(comparison) as Comparison,
        } satisfies ExperimentEntry);
      const runs = path.join(dir, 'runs');
      if (await isDir(runs))
        for (const name of (await readdir(runs)).sort())
          await tryRun(path.join(runs, name), parsed.data.id);
      return;
    }
    if ((await readIfPresent(path.join(dir, 'summary.json'))) !== null)
      return tryRun(dir, null);
    if (depth >= 2) return;
    for (const name of (await readdir(dir)).sort())
      if (!name.startsWith('.') && (await isDir(path.join(dir, name))))
        await walk(path.join(dir, name), depth + 1);
  };
  if (await isDir(resultsDir)) await walk(resultsDir, 0);
  return { index, details };
}

async function main() {
  const flag = process.argv.indexOf('--results');
  const resultsDir = path.resolve(
    process.env['INIT_CWD'] ?? '',
    flag !== -1
      ? process.argv[flag + 1]!
      : (process.env['EAW_RESULTS_DIR'] ?? path.join(viewerRoot, '..', 'results')),
  );
  const { index, details } = await loadResults(resultsDir);
  const out = path.join(viewerRoot, 'public', 'data');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'index.json'), JSON.stringify(index));
  for (const run of details) {
    const file = path.join(out, 'runs', run.key + '.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(run));
  }
  console.log(
    `[viz] ${resultsDir}: ${index.runs.length} runs, ${index.experiments.length} experiments, ${index.skipped.length} skipped (not v4)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
