#!/usr/bin/env node
import { buildRunConfig, type RunConfigInput } from './config/run-config.js';
import { SCENARIOS } from './scenarios/catalog.js';
import { runEvaluation, validateDryRun } from './runner.js';

const HELP = `Usage:
  pnpm eval --list-scenarios
  pnpm eval --scenario <id> [options]

Options:
  --fixture <path>          Fixture repository
  --fixture-commit <sha>    Pinned fixture commit
  --provider <id>           Pi provider or claude-code (default openai-codex)
  --model <id>              Model (default gpt-5.6-luna)
  --thinking <level>        Thinking level (default high)
  --results <path>          Artifact directory
  --workspace-root <path>   Disposable workspace parent
  --run-id <id>             Deterministic artifact directory name
  --max-turns <n>           Maximum model turns
  --max-actions <n>         Maximum tool actions
  --timeout-ms <n>          Run timeout
  --dependency-mode <mode>  copy | symlink | none (default copy)
  --ticket-delivery <mode>  slack | direct (default slack)
  --dry-run                 Validate and prepare without inference
  --keep-workspace          Retain the disposable checkout
  --skip-hidden-checks      Skip external behavior checks
`;

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error(`${flag} requires a value`);
  return value;
}
function positive(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}
function parseArgs(args: string[]): {
  list: boolean;
  help: boolean;
  input: RunConfigInput;
} {
  const input: RunConfigInput = { scenarioId: '' };
  let list = false,
    help = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--list-scenarios') list = true;
    else if (flag === '--help' || flag === '-h') help = true;
    else if (flag === '--dry-run') input.dryRun = true;
    else if (flag === '--keep-workspace') input.keepWorkspace = true;
    else if (flag === '--skip-hidden-checks') input.skipHiddenChecks = true;
    else {
      const value = requiredValue(args, index, flag);
      index += 1;
      if (flag === '--scenario') input.scenarioId = value;
      else if (flag === '--fixture') input.fixturePath = value;
      else if (flag === '--fixture-commit') input.fixtureCommit = value;
      else if (flag === '--provider') input.provider = value;
      else if (flag === '--model') input.model = value;
      else if (flag === '--thinking') input.thinkingLevel = value;
      else if (flag === '--results') input.resultsDir = value;
      else if (flag === '--workspace-root') input.workspaceRoot = value;
      else if (flag === '--dependency-mode') input.dependencyMode = value;
      else if (flag === '--ticket-delivery') input.ticketDelivery = value;
      else if (flag === '--run-id') input.runId = value;
      else if (flag === '--max-turns') input.maxTurns = positive(value, flag);
      else if (flag === '--max-actions') input.maxActions = positive(value, flag);
      else if (flag === '--timeout-ms') input.timeoutMs = positive(value, flag);
      else throw new Error(`unknown option: ${flag}`);
    }
  }
  return { list, help, input };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.list) {
    for (const scenario of SCENARIOS) {
      const suffix = scenario.unsupportedReason === undefined ? '' : ' [unsupported]';
      process.stdout.write(`${scenario.id}${suffix}\t${scenario.description}\n`);
    }
    return;
  }
  if (parsed.input.scenarioId.length === 0) throw new Error('--scenario is required');
  const config = buildRunConfig(parsed.input);
  if (config.dryRun) {
    const result = await validateDryRun(config);
    process.stdout.write(
      JSON.stringify({ mode: 'dry-run', config, result }, null, 2) + '\n',
    );
    return;
  }
  const summary = await runEvaluation(config);
  process.stdout.write(
    JSON.stringify(
      {
        runId: summary.runId,
        classification: summary.grade.classification,
        valid: summary.grade.valid,
        artifacts: summary.artifacts,
      },
      null,
      2,
    ) + '\n',
  );
}
main().catch((error: unknown) => {
  process.stderr.write(
    `eval failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
