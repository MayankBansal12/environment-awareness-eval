import type { RunDetail, RunRow } from '../model.js';
import type { Summary } from '../../../src/schema.js';
export function scenarioBehavior(s: Summary): RunRow['scenarioBehavior'] {
  if (s.condition.updates === 'disabled') {
    const result = s.grade.outcome['noiseControlPassed'];
    return !s.grade.valid || s.grade.censored || typeof result !== 'boolean'
      ? 'unassessable'
      : result
        ? 'passed'
        : 'failed';
  }
  if (!s.condition.scenario || s.condition.scenario === 'updates') return undefined;
  const outcomes = s.grade.events.filter(
    (e) => (e.suppression || e.delayed) && e.adapted !== null,
  );
  if (!s.grade.valid || s.grade.censored || !outcomes.length) return 'unassessable';
  return outcomes.some((e) => !e.adapted) ? 'failed' : 'passed';
}
export const conditionLabel = (r: RunRow) =>
  `${r.condition.family} / ${r.condition.load} / ${r.condition.noise} / ${r.condition.delivery}${r.condition.scenario && r.condition.scenario !== 'updates' ? ' / ' + r.condition.scenario : ''}${r.condition.updates === 'disabled' ? ' / noise-only control' : ''}`;
export const modelLabel = (run: RunDetail) =>
  [run.summary.runtime['model'], run.summary.runtime['thinking']]
    .filter(Boolean)
    .join(' · ');
export const classificationTone = (run: RunDetail) =>
  !run.summary.grade.valid ||
  run.summary.grade.censored ||
  scenarioBehavior(run.summary) === 'unassessable'
    ? 'invalid'
    : scenarioBehavior(run.summary) === 'failed' ||
        run.summary.grade.events.some(
          (e) => e.missed || ((e.suppression || e.delayed) && e.adapted === false),
        )
      ? 'bad'
      : 'good';
export const outcomeLabel = (run: RunDetail) =>
  !run.summary.grade.valid
    ? 'Invalid run'
    : run.summary.grade.censored
      ? 'Censored run'
      : scenarioBehavior(run.summary) === 'unassessable'
        ? 'Scenario unassessable'
        : run.summary.condition.updates === 'disabled'
          ? scenarioBehavior(run.summary) === 'passed'
            ? 'Noise-only control passed'
            : 'Noise-only control failed'
          : run.summary.grade.events.some(
                (e) => (e.suppression || e.delayed) && e.adapted === false,
              )
            ? 'Scenario behavior failed'
            : `${run.summary.grade.summary['importantMissed'] ?? 0} of ${run.summary.grade.summary['importantFired'] ?? 0} updates missed`;
export const TONE_GLYPH = { good: '●', bad: '×', invalid: '◇' };
