import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRuntime, selectModel } from './harness/model.js';
import { verifyClaudeCode } from './harness/claude-code.js';
import { auditRun } from './audit.js';
import { calibrate } from './calibrate.js';
import { compare, execute, freeze, profileSchema } from './experiment.js';
import { DEFAULT_BUDGETS, run } from './runner.js';
import { conditionSchema, familySchema, type FamilyId } from './scenario.js';

const USAGE = `pnpm eval <command>

  calibrate [out.json]                    Verify fixtures, bugs per load and reference solutions (no inference)
  verify-model [--provider P --model M --thinking T]
  run --family F --load L [--noise N] [--delivery D] [--seed S] [--run-id ID] [--results DIR]
      [--provider P --model M --thinking T] [--timeout-min 60] [--max-tokens N] [--no-compaction]
                                          One development run outside a manifest
  freeze <manifest.json> <id> <smoke|load-sweep|controls> [--reps 3] [--seed S] [--families a,b]
      [--provider P --model M --thinking T] [--timeout-min 60] [--max-tokens N] [--no-compaction]
  execute <manifest.json> [maxNew]        Run pending trials (provider errors are re-attempted)
  compare <manifest.json>                 Rebuild comparison.json / comparison.md
  audit <run-dir>`;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      thinking: { type: 'string' },
      family: { type: 'string' },
      load: { type: 'string' },
      noise: { type: 'string' },
      delivery: { type: 'string' },
      seed: { type: 'string' },
      reps: { type: 'string' },
      families: { type: 'string' },
      'run-id': { type: 'string' },
      results: { type: 'string' },
      'timeout-min': { type: 'string' },
      'max-tokens': { type: 'string' },
      'no-compaction': { type: 'boolean' },
    },
  });
  const [command, a, b, c] = positionals;
  if (Boolean(values.provider) !== Boolean(values.model))
    throw Error('Provide both --provider and --model');
  const selection = selectModel(values);
  const budgets = {
    ...DEFAULT_BUDGETS,
    ...(values['timeout-min'] ? { timeoutMs: Number(values['timeout-min']) * 60_000 } : {}),
    ...(values['max-tokens'] ? { maxTotalTokens: Number(values['max-tokens']) } : {}),
    ...(values['no-compaction'] ? { compaction: false } : {}),
  };

  if (command === 'calibrate') {
    const report = await calibrate();
    if (a) await writeFile(a, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report.summary, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'verify-model') {
    console.log(
      JSON.stringify(
        selection.provider === 'anthropic'
          ? await verifyClaudeCode(selection)
          : (await createRuntime(selection)).verification,
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'run') {
    const condition = conditionSchema.parse({
      family: values.family,
      load: values.load,
      noise: values.noise ?? 'normal',
      delivery: values.delivery ?? 'ambient',
      seed: Number(values.seed ?? 1),
    });
    const runId =
      values['run-id'] ??
      `dev-${condition.family}-${condition.load}-${condition.noise}-${condition.delivery}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const summary = await run({
      runId,
      resultsDir: values.results ?? 'results/dev',
      condition,
      budgets,
      keepWorkspace: false,
      modelConfig: selection,
    });
    console.log(path.join(values.results ?? 'results/dev', runId, 'report.md'));
    console.log(
      JSON.stringify(
        {
          termination: summary.termination,
          usage: summary.usage,
          summary: summary.grade.summary,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'freeze' && a && b && c) {
    const manifest = await freeze(a, {
      id: b,
      profile: profileSchema.parse(c),
      seed: Number(values.seed ?? 0),
      repetitions: Number(values.reps ?? 3),
      families: (values.families?.split(',') ?? familySchema.options).map((f) =>
        familySchema.parse(f),
      ) as FamilyId[],
      modelConfig: selection,
      budgets,
    });
    console.log(
      JSON.stringify(
        {
          id: manifest.id,
          trials: manifest.trials.length,
          model: manifest.modelConfig,
          budgets: manifest.budgets,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'execute' && a) {
    const result = await execute(a, 'results', b ? Number(b) : Infinity);
    console.log(
      JSON.stringify(
        {
          launched: result.launched,
          haltedBy: result.haltedBy,
          completed: result.completed,
          scheduled: result.scheduled,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'compare' && a) {
    console.log(JSON.stringify(await compare(a, 'results'), null, 2));
    return;
  }
  if (command === 'audit' && a) {
    const audit = await auditRun(a);
    console.log(JSON.stringify(audit, null, 2));
    if (!audit.eligible) process.exitCode = 1;
    return;
  }
  console.log(USAGE);
}

main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
