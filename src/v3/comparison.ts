import type { Grade } from './schema.js';
import type { Sequence, Delivery } from './state.js';
import type { Demand } from '../v2/state.js';

export interface ComparisonTrial {
  id: string;
  sequence: Sequence;
  delivery: Delivery;
  demand: Demand;
  replicate?: number | undefined;
  model?: string;
  thinking?: string;
  state: string;
  valid?: boolean;
  outcome?: string;
  termination?: { reason: string; detail: string };
  metrics?: Grade['metrics'];
  gates?: Grade['gates'];
}
const numeric = (t: ComparisonTrial, name: string): number | null =>
  typeof t.metrics?.[name] === 'number' ? (t.metrics[name] as number) : null;
const values = (trials: ComparisonTrial[], name: string) =>
  trials.flatMap((t) => (numeric(t, name) === null ? [] : [numeric(t, name)!]));

/** Wilson interval describes a binomial proportion, not a causal effect. */
export function fraction(successes: number, n: number) {
  if (!n) return { successes, n, proportion: null, interval95: null };
  const z = 1.959963984540054,
    p = successes / n,
    d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return {
    successes,
    n,
    proportion: p,
    interval95: [Math.max(0, c - h), Math.min(1, c + h)],
  };
}

export function aggregate(trials: ComparisonTrial[]) {
  const cellKey = (t: ComparisonTrial) =>
    [t.model, t.thinking, t.sequence, t.delivery, t.demand]
      .filter((v) => v !== undefined)
      .join('/');
  const keys = [...new Set(trials.map(cellKey))];
  const cells = keys.map((key) => {
    const all = trials.filter((t) => cellKey(t) === key);
    const completed = all.filter((t) => t.state === 'completed');
    const eligible = completed.filter((t) => t.valid);
    const assigned = eligible.filter((t) => numeric(t, 'assignmentDecision') !== null);
    const revised = eligible.filter((t) => numeric(t, 'revisionDecision') !== null);
    const opportunities = revised.filter(
      (t) => t.metrics?.['revisionResponseOpportunityDuringUrgent'] === true,
    );
    const uncensored = opportunities.filter(
      (t) => t.metrics?.['revisionWithinFiveDecisions'] !== 'censored',
    );
    return {
      key,
      scheduled: all.length,
      attempted: all.filter((t) => t.state !== 'not_started').length,
      completed: completed.length,
      eligible: eligible.length,
      invalid: completed.length - eligible.length,
      incompleteOrSetupFailure: all.filter(
        (t) => !['completed', 'not_started'].includes(t.state),
      ).length,
      noAssignment: eligible.length - assigned.length,
      budgetLimited: eligible.filter((t) => t.metrics?.['budgetLimited'] === true).length,
      assignmentRetrieved: fraction(
        assigned.filter((t) => numeric(t, 'firstAssignmentContent') !== null).length,
        assigned.length,
      ),
      assignmentNeverRetrieved: assigned.filter(
        (t) => numeric(t, 'firstAssignmentContent') === null,
      ).length,
      revisionTriggered: revised.length,
      revisionWhileUrgentOpportunity: opportunities.length,
      revisionWithoutUrgentOpportunity: revised.length - opportunities.length,
      meaningfulUrgentWorkRemaining: opportunities.filter(
        (t) => (numeric(t, 'urgentChecksRemainingAtCheckpoint') ?? 0) > 0,
      ).length,
      revisionRetrieved: fraction(
        opportunities.filter((t) => numeric(t, 'firstRevisionContent') !== null).length,
        opportunities.length,
      ),
      revisionNeverRetrieved: opportunities.filter(
        (t) => numeric(t, 'firstRevisionContent') === null,
      ).length,
      revisionFiveDecisionCensored: opportunities.length - uncensored.length,
      revisionWithinFiveDecisions: fraction(
        uncensored.filter((t) => t.metrics?.['revisionWithinFiveDecisions'] === 'retrieved')
          .length,
        uncensored.length,
      ),
      workflowCompleted: fraction(
        eligible.filter((t) => t.outcome === 'workflow_completed').length,
        eligible.length,
      ),
      functionalPassed: eligible.filter((t) =>
        ['feature_final_correct', 'urgent_fix_preserved'].every((id) =>
          t.gates?.some((g) => g.id === id && g.passed),
        ),
      ).length,
      raw: Object.fromEntries(
        [
          'decisions',
          'discoveryDelay',
          'resumptionDelay',
          'revisionRetrievalDelay',
          'urgentWorkDecisions',
          'urgentSourceChangeBatches',
          'urgentTestRuns',
          'urgentTestRunsWithFailures',
          'urgentTestRunsWithFailuresAfterFirstChange',
          'urgentFocusedTestRunsWithFailuresAfterFirstChange',
          'urgentChecksRemainingAtCheckpoint',
        ].map((name) => [name, values(eligible, name)]),
      ),
    };
  });
  const contrasts = trials
    .filter((t) => t.demand === 'lower')
    .map((lower) => {
      const higher = trials.find(
        (t) =>
          t.demand === 'higher' &&
          t.model === lower.model &&
          t.thinking === lower.thinking &&
          t.sequence === lower.sequence &&
          t.delivery === lower.delivery &&
          t.replicate === lower.replicate,
      );
      const comparable = Boolean(lower.valid && higher?.valid);
      return {
        model: lower.model ?? null,
        thinking: lower.thinking ?? null,
        sequence: lower.sequence,
        delivery: lower.delivery,
        replicate: lower.replicate ?? null,
        lower: lower.id,
        higher: higher?.id ?? null,
        comparable,
        higherMinusLower: Object.fromEntries(
          [
            'urgentWorkDecisions',
            'urgentSourceChangeBatches',
            'urgentTestRunsWithFailures',
            'urgentTestRunsWithFailuresAfterFirstChange',
            'urgentFocusedTestRunsWithFailuresAfterFirstChange',
            'resumptionDelay',
            'revisionRetrievalDelay',
          ].map((name) => {
            const l = numeric(lower, name),
              h = higher ? numeric(higher, name) : null;
            return [name, comparable && l !== null && h !== null ? h - l : null];
          }),
        ),
      };
    });
  return {
    cells,
    contrasts,
    interpretation:
      'Raw development trajectories and descriptive matched contrasts. Latency arrays contain retrievers only; never-retrieved, censored and missing opportunities are counted separately. Wilson intervals are descriptive and do not establish independent samples, causal effects or cognitive load.',
  };
}
