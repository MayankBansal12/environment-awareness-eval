/**
 * Semantic trigger evaluation.
 *
 * Triggers are evaluated only at decision boundaries, only from Git snapshots and
 * recorded tool observations, and each fires at most once per run. No trigger consults
 * wall-clock time.
 */

import type { Trigger } from '../config/scenario-schema.js';
import type { WorkspaceSnapshot } from '../workspace/snapshot.js';

export type TestOutcome = 'passed' | 'failed' | 'unknown';

export interface ObservedTestRun {
  actionIndex: number;
  turnIndex: number;
  command: string;
  outcome: TestOutcome;
}

export interface ObservedCommit {
  actionIndex: number;
  turnIndex: number;
  command: string;
  succeeded: boolean;
}

export interface TriggerContext {
  snapshot: WorkspaceSnapshot;
  testRuns: readonly ObservedTestRun[];
  commitAttempts: readonly ObservedCommit[];
  turnIndex: number;
}

export interface TriggerDecision {
  fired: boolean;
  evidence: Record<string, unknown>;
}

const TEST_COMMAND =
  /\b(?:vitest|jest)\b|\b(?:pnpm|npm|yarn|bun|node)\s+(?:run\s+|--run\s+)?test\b/;
const COMMIT_COMMAND = /\bgit\s+(?:-[^\s]+\s+|--[^\s]+\s+)*commit\b/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

export function isCommitCommand(command: string): boolean {
  return COMMIT_COMMAND.test(command);
}

/**
 * Decide whether an observed test invocation passed.
 *
 * The tool's error flag alone is not enough: a model may pipe test output through `tail`
 * or append `|| true`, which masks the exit status. Reporter lines are therefore checked
 * first and the exit status is only a fallback.
 */
export function classifyTestOutcome(isError: boolean, output: string): TestOutcome {
  if (
    /Tests\s+[^\n]*\d+\s+failed/.test(output) ||
    /Test Files\s+[^\n]*\d+\s+failed/.test(output)
  ) {
    return 'failed';
  }
  if (/Tests\s+\d+\s+passed/.test(output) || /Test Files\s+\d+\s+passed/.test(output)) {
    return 'passed';
  }
  if (/\bno test files found\b/i.test(output)) {
    return 'unknown';
  }
  return isError ? 'failed' : 'unknown';
}

export function evaluateTrigger(
  trigger: Trigger,
  context: TriggerContext,
): TriggerDecision {
  switch (trigger) {
    case 'none':
      return { fired: false, evidence: {} };

    case 'first_source_mutation':
      return {
        fired: context.snapshot.sourceMutated,
        evidence: {
          changedWatchedFiles: context.snapshot.changedWatchedFiles,
          untrackedWatchedFiles: context.snapshot.untrackedWatchedFiles,
          trackedSourceDigest: context.snapshot.trackedSourceDigest,
        },
      };

    case 'first_observed_failing_test': {
      const failing = context.testRuns.find((run) => run.outcome === 'failed');
      return {
        fired: failing !== undefined,
        evidence: failing === undefined ? {} : { ...failing },
      };
    }

    case 'tests_first_pass': {
      const passing = context.testRuns.find(
        (run) =>
          run.outcome === 'passed' &&
          run.turnIndex === context.turnIndex &&
          context.snapshot.sourceMutated &&
          isFullVisibleSuiteCommand(run.command),
      );
      return {
        fired: passing !== undefined,
        evidence: passing === undefined ? {} : { ...passing },
      };
    }

    case 'pre_commit_attempt':
      // Reached only if scenario validation is bypassed. Firing here would require
      // intercepting the commit tool call, which is exactly the timing hack the protocol
      // forbids, so the trigger never fires.
      return {
        fired: false,
        evidence: { unsupported: true, commitAttempts: context.commitAttempts.length },
      };

    default: {
      const exhaustive: never = trigger;
      throw new Error('unhandled trigger: ' + String(exhaustive));
    }
  }
}

/** Wraps `evaluateTrigger` with the "at most once per run" guarantee. */
export class OneShotTrigger {
  #fired = false;
  #firedAtTurn: number | undefined;

  constructor(private readonly trigger: Trigger) {}

  get hasFired(): boolean {
    return this.#fired;
  }

  get firedAtTurn(): number | undefined {
    return this.#firedAtTurn;
  }

  evaluate(context: TriggerContext): TriggerDecision | undefined {
    if (this.#fired) return undefined;
    const decision = evaluateTrigger(this.trigger, context);
    if (!decision.fired) return undefined;
    this.#fired = true;
    this.#firedAtTurn = context.turnIndex;
    return decision;
  }
}

export function isFullVisibleSuiteCommand(command: string): boolean {
  if (!isTestCommand(command)) return false;
  return !/(?:tests?\/|src\/)|\.(?:test|spec)\.\w+\b/.test(command);
}
