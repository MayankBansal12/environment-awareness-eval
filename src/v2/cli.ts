import path from 'node:path';
import { CONDITIONS } from './state.js';
import { runV2 } from './runner.js';
import { FREE_MODEL, FREE_PROVIDER, freeRuntime } from './model.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list-scenarios')) {
    for (const s of CONDITIONS) console.log(s.id);
    return;
  }
  if (args.includes('--verify-model')) {
    const { verification } = await freeRuntime();
    console.log(JSON.stringify(verification, null, 2));
    return;
  }
  if (args.includes('--help')) {
    console.log(
      `pnpm eval:v2 --scenario <${CONDITIONS[0]!.id}|...> [--run-id <unique-id>] [--results <path>] [--keep-workspace] [--max-turns N] [--max-actions N] [--timeout-ms N]\nOnly ${FREE_PROVIDER}/${FREE_MODEL} is permitted. --verify-model performs no inference.`,
    );
    return;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--keep-workspace') continue;
    if (
      ![
        '--scenario',
        '--run-id',
        '--results',
        '--max-turns',
        '--max-actions',
        '--timeout-ms',
      ].includes(flag)
    )
      throw new Error('Unsupported argument: ' + flag);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing value: ' + flag);
    values.set(flag, value);
  }
  const scenario = CONDITIONS.find((s) => s.id === values.get('--scenario'));
  if (!scenario) throw new Error('Choose a scenario with --list-scenarios');
  const number = (key: string, fallback: number, max: number) => {
    const value = Number(values.get(key) ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error('Invalid budget ' + key);
    return value;
  };
  const summary = await runV2({
    demand: scenario.demand,
    condition: scenario.condition,
    runId:
      values.get('--run-id') ??
      `${scenario.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    resultsDir: path.resolve(values.get('--results') ?? 'results'),
    maxTurns: number('--max-turns', 45, 100),
    maxActions: number('--max-actions', 120, 300),
    timeoutMs: number('--timeout-ms', 900000, 1200000),
    keepWorkspace: args.includes('--keep-workspace'),
  });
  console.log(
    JSON.stringify(
      { runId: summary.runId, grade: summary.grade, artifacts: summary.artifacts },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
