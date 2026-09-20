import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Comparison } from '../../src/experiment.js';
import { rowOf } from '../scripts/build-data.js';
import { simulate } from '../scripts/fixtures.js';
import {
  cellEvent,
  filterRuns,
  NO_FILTERS,
  trendGroups,
  type Cell,
} from '../src/derive.js';
import { classificationTone, conditionLabel, outcomeLabel } from '../src/derive/metrics.js';
import type { RunDetail } from '../src/model.js';
import { Evidence } from '../src/ui/Evidence.js';

function fixture(): RunDetail {
  const data = simulate({
    runId: 'old',
    condition: {
      family: 'settlement',
      load: 'high',
      noise: 'normal',
      delivery: 'ambient',
      seed: 1,
    },
    model: { provider: 'openai-codex', model: 'gpt-6-astra', thinking: 'medium' },
  });
  return {
    key: 'old/runs/t001',
    summary: data.summary,
    trace: data.trace,
    header: null,
    capture: null,
    messages: [],
    inputs: {},
    outputs: {},
  };
}

describe('scenario viewer compatibility', () => {
  it('labels noise-only outcomes separately from suppression results', () => {
    const run = fixture();
    run.summary.condition.delivery = 'interrupt';
    run.summary.condition.updates = 'disabled';
    run.summary.grade.valid = true;
    run.summary.grade.censored = false;
    run.summary.grade.events = [];
    run.summary.grade.outcome['noiseControlPassed'] = false;
    expect(rowOf(run, 'pilot').scenarioBehavior).toBe('failed');
    expect(outcomeLabel(run)).toBe('Noise-only control failed');
    expect(classificationTone(run)).toBe('bad');
    expect(conditionLabel(rowOf(run, 'pilot'))).toContain('noise-only control');
    const enabled = fixture();
    const rows = [rowOf(run, 'pilot'), rowOf(enabled, 'old')];
    expect(filterRuns(rows, { ...NO_FILTERS, updates: 'disabled' })).toEqual([rows[0]]);
    const comparison = {
      cells: [
        { cell: 'settlement/high/normal/interrupt/task-cancellation' },
        { cell: 'settlement/high/normal/interrupt/task-cancellation/noise-only-control' },
      ],
    } as Comparison;
    expect(trendGroups(comparison)).toHaveLength(2);
    run.summary.grade.outcome['noiseControlPassed'] = true;
    expect(outcomeLabel(run)).toBe('Noise-only control passed');
  });
  it('keeps historical runs and new arms independently filterable', () => {
    const old = fixture();
    const next = structuredClone(old);
    next.key = 'new/runs/t001';
    next.summary.condition.scenario = 'task-cancellation';
    const rows = [rowOf(old, 'old'), rowOf(next, 'new')];
    expect(filterRuns(rows, { ...NO_FILTERS, scenario: 'updates' })).toEqual([rows[0]]);
    expect(filterRuns(rows, { ...NO_FILTERS, scenario: 'task-cancellation' })).toEqual([
      rows[1],
    ]);
    expect(conditionLabel(rows[0]!)).not.toBe(conditionLabel(rows[1]!));
    expect(rows[1]?.scenarioBehavior).toBe('unassessable');
    expect(outcomeLabel(next)).toBe('Scenario unassessable');
  });
  it('renders a suppression failure even when the update was retrieved', () => {
    const run = fixture();
    run.summary.condition.scenario = 'task-cancellation';
    run.summary.grade.valid = true;
    run.summary.grade.censored = false;
    run.summary.grade.events = [
      {
        ...run.summary.grade.events[0]!,
        kind: 'task_cancellation',
        adapted: false,
        missed: false,
        suppression: {
          target: 'focal',
          sourceChangesAfterFire: 1,
          sourceChangesAfterContent: 1,
          testRunsAfterFire: 0,
          forbiddenStatusTransitions: 0,
          checks: [{ id: 'task_cancellation_source_preserved', passed: false }],
        },
      },
    ];
    expect(rowOf(run, 'new').scenarioBehavior).toBe('failed');
    expect(classificationTone(run)).toBe('bad');
    expect(outcomeLabel(run)).toBe('Scenario behavior failed');
    const html = renderToStaticMarkup(
      createElement(Evidence, { run, selected: 1, select: () => {} }),
    );
    expect(html).toContain('Behavior failed');
    expect(html).toContain('task_cancellation_source_preserved');
    expect(html).toContain('Source changes after update: 1');
  });
  it('handles old comparison files without new event keys and never merges scenario cells', () => {
    const old = { cell: 'settlement/high/normal/ambient', events: {} } as Cell;
    expect(cellEvent(old, 'task_cancellation').adapted.proportion).toBeNull();
    const comparison = {
      cells: [
        old,
        { ...old, cell: old.cell + '/task-cancellation' },
        { ...old, cell: old.cell + '/delayed-relevance' },
      ],
    } as Comparison;
    expect(trendGroups(comparison)).toHaveLength(3);
  });
});
