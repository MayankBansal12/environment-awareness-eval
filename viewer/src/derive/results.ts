import type { RunRow } from '../model.js';

/** The index's model label may also include a thinking setting after the separator. */
export const modelId = (label: string) => label.split(' · ')[0]!.trim();

export const modelName = (label: string) =>
  modelId(label).replace(
    /^claude-([a-z]+)-(.+)$/,
    (_, family: string, version: string) =>
      `Claude ${family[0]!.toUpperCase()}${family.slice(1)} ${version}`,
  );

export interface ModelResult {
  model: string;
  runs: RunRow[];
  validRuns: number;
  finishedRuns: number;
  importantMissed: number;
  importantFired: number;
  decisions: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
}

/** Usage includes every run; update outcomes include only valid, uncensored runs. */
export function modelResults(runs: readonly RunRow[]): ModelResult[] {
  const groups = new Map<string, ModelResult>();
  for (const run of runs) {
    const model = modelId(run.model);
    let group = groups.get(model);
    if (!group) {
      group = {
        model,
        runs: [],
        validRuns: 0,
        finishedRuns: 0,
        importantMissed: 0,
        importantFired: 0,
        decisions: 0,
        totalTokens: 0,
        costUsd: 0,
        durationMs: 0,
      };
      groups.set(model, group);
    }
    group.runs.push(run);
    if (run.valid && !run.censored) {
      group.validRuns++;
      group.importantMissed += run.importantMissed;
      group.importantFired += run.importantFired;
    }
    if (run.termination === 'agent_finished') group.finishedRuns++;
    group.decisions += run.decisions;
    group.totalTokens += run.totalTokens;
    group.costUsd += run.costUsd;
    group.durationMs += run.durationMs;
  }
  return [...groups.values()];
}
