import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { modelId, modelName, modelResults } from '../src/derive/results.js';
import type { RunRow, ViewerIndex } from '../src/model.js';
import { RunList } from '../src/ui/RunList.js';

const row = (key: string, overrides: Partial<RunRow> = {}): RunRow => ({
  key,
  runId: key,
  experiment: null,
  condition: {
    family: 'settlement',
    load: 'high',
    noise: 'normal',
    delivery: 'ambient',
    seed: 1,
  },
  model: 'claude-opus-5 · default',
  termination: 'agent_finished',
  valid: true,
  censored: false,
  decisions: 10,
  totalTokens: 1000,
  costUsd: 0.25,
  durationMs: 60_000,
  importantFired: 4,
  importantMissed: 1,
  ...overrides,
});

const runs = [
  row('opus-settlement-r1'),
  row('opus-fulfillment-r2', {
    model: 'claude-opus-5 · high',
    experiment: 'another-experiment',
    condition: {
      family: 'fulfillment',
      load: 'low',
      noise: 'none',
      delivery: 'exposed',
      seed: 2,
    },
    decisions: 20,
    totalTokens: 3000,
    costUsd: 0.75,
    durationMs: 120_000,
    importantFired: 2,
    importantMissed: 0,
  }),
  row('opus-invalid', { valid: false, termination: 'error', importantMissed: 4 }),
  row('opus-censored', { censored: true, termination: 'limit', importantMissed: 3 }),
  row('sonnet-r1', { model: 'claude-sonnet-5 · default' }),
  row('future-r1', { model: 'provider/future-model · medium' }),
];
const index: ViewerIndex = {
  generatedAt: '2026-09-18T00:00:00Z',
  resultsDir: '/results',
  runs,
  experiments: [],
  skipped: [],
};
const render = (query = '', data = index) =>
  renderToStaticMarkup(
    createElement(RunList, { index: data, query: new URLSearchParams(query) }),
  );

describe('model results', () => {
  it('combines conditions, experiments and thinking settings by model', () => {
    const models = modelResults(runs);
    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({
      model: 'claude-opus-5',
      runs: runs.slice(0, 4),
      validRuns: 2,
      finishedRuns: 2,
      importantFired: 6,
      importantMissed: 1,
      decisions: 50,
      totalTokens: 6000,
      costUsd: 1.5,
      durationMs: 300_000,
    });
    expect(models[1]).toMatchObject({ model: 'claude-sonnet-5', costUsd: 0.25 });
    expect(models[2]).toMatchObject({ model: 'provider/future-model', validRuns: 1 });
    expect(modelResults([])).toEqual([]);
  });

  it('uses readable Claude names and preserves unrecognized model IDs', () => {
    expect(modelId('claude-opus-5 · default')).toBe('claude-opus-5');
    expect(modelName('claude-opus-5 · high')).toBe('Claude Opus 5');
    expect(modelName('claude-sonnet-5')).toBe('Claude Sonnet 5');
    expect(modelName('provider/future-model · medium')).toBe('provider/future-model');
  });

  it('renders one linked summary per model instead of individual run rows', () => {
    const html = render();
    expect(html.match(/class="result-row"/g)).toHaveLength(3);
    expect(html).toContain('3 models · 6 runs');
    expect(html).toContain('href="#/run/opus-settlement-r1">Claude Opus 5</a>');
    expect(html).toContain('href="#/run/sonnet-r1">Claude Sonnet 5</a>');
    expect(html).not.toContain('>opus-settlement-r1</a>');
    expect(html).not.toContain(' · default');
    expect(html).toContain('<td class="num">1/6</td>');
    expect(html).toContain('<td class="num">6.0k</td>');
    expect(html).toContain('<td class="num">$1.50</td>');
    expect(html).toContain('<td class="num">5.0 min</td>');
  });

  it('filters before aggregating and links to a matching run', () => {
    const html = render('family=fulfillment');
    expect(html.match(/class="result-row"/g)).toHaveLength(1);
    expect(html).toContain('1 model · 1 run');
    expect(html).toContain('1 of 6 runs');
    expect(html).toContain('href="#/run/opus-fulfillment-r2">Claude Opus 5</a>');
    expect(html).toContain('<td class="num">0/2</td>');
    expect(html).toContain('<td class="num">3.0k</td>');
    expect(html).not.toContain('Claude Sonnet 5');
  });

  it('shows empty filters and unavailable update rates without implying success', () => {
    expect(render('scenario=delayed-relevance')).toContain('No runs match these filters.');
    const html = render('', { ...index, runs: [runs[2]!] });
    expect(html).toContain('<td class="num">0/1</td>');
    expect(html).toContain('<td class="num">—</td>');
    expect(render('', { ...index, runs: [] })).toContain('No v4 runs found');
  });
});
