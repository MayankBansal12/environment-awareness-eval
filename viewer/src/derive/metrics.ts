import type { RunDetail, RunRow } from '../model.js';
export const conditionLabel = (r: RunRow) =>
  `${r.condition.family} / ${r.condition.load} / ${r.condition.noise} / ${r.condition.delivery}`;
export const modelLabel = (run: RunDetail) =>
  [run.summary.runtime['model'], run.summary.runtime['thinking']]
    .filter(Boolean)
    .join(' · ');
export const classificationTone = (run: RunDetail) =>
  !run.summary.grade.valid || run.summary.grade.censored
    ? 'invalid'
    : run.summary.grade.events.some((e) => e.missed)
      ? 'bad'
      : 'good';
export const outcomeLabel = (run: RunDetail) =>
  !run.summary.grade.valid
    ? 'Invalid run'
    : run.summary.grade.censored
      ? 'Censored run'
      : `${run.summary.grade.summary['importantMissed'] ?? 0} of ${run.summary.grade.summary['importantFired'] ?? 0} updates missed`;
export const TONE_GLYPH = { good: '●', bad: '×', invalid: '◇' };
