import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { V2Runs } from '../src/ui/V2Runs.js';
import { TeamState } from '../../src/v2/state.js';
import { summarySchema, type V2Bundle } from '../../src/v2/schema.js';

const state = new TeamState('linear');
state.cancel();
const bundle: V2Bundle = {
  summary: summarySchema.parse({
    format: 'environment-v2',
    schemaVersion: 1,
    runId: 'sample',
    demand: 'higher',
    condition: 'linear',
    runtime: { model: 'test-model' },
    fixtureCommit: 'seed',
    fixtureDigest: 'hash',
    termination: { reason: 'agent_finished', detail: 'finished' },
    grade: {
      valid: true,
      classification: 'correct_adaptation',
      validity: [],
      outcomes: [],
      metrics: { contentSource: 'linear', contentDecision: 3 },
    },
    finalTicket: state.current(),
    finalWorkspace: {
      digest: 'x',
      implementationDigest: 'x',
      commits: [],
      status: ' M src/service.mjs',
      changedPaths: [],
    },
    hiddenChecks: [],
    visibleTests: { passed: false, output: 'unfinished' },
    capture: { complete: true, partialContent: false, inputs: 1, outputs: 1 },
    artifacts: {},
    retainedWorkspace: null,
  }),
  trace: [],
  context: [
    {
      type: 'input',
      decision: 3,
      messages: [
        { role: 'toolResult', text: 'Status: cancelled', chars: 17, truncated: false },
      ],
    },
    {
      type: 'output',
      decision: 3,
      message: { role: 'assistant', text: 'Stopping now.', chars: 13, truncated: false },
    },
  ],
};

describe('v2 results with no historical corpus', () => {
  it('renders an empty index', () => {
    expect(renderToStaticMarkup(createElement(V2Runs, { runs: [] }))).toContain('0 runs');
  });
  it('renders condition and behavior in the index', () => {
    const html = renderToStaticMarkup(createElement(V2Runs, { runs: [bundle] }));
    expect(html).toContain('higher');
    expect(html).toContain('correct adaptation');
  });
  it('shows ticket state, source metrics, exact input/output and functional-check limitations', () => {
    const html = renderToStaticMarkup(
      createElement(V2Runs, { runs: [bundle], initialRunId: 'sample' }),
    );
    for (const text of [
      'Final ticket state',
      'cancelled',
      'contentSource',
      'Status: cancelled',
      'Stopping now.',
      'Functional completion is not required after cancellation',
    ])
      expect(html).toContain(text);
  });
});

import { Experiments } from '../src/ui/Experiments.js';
import type { Comparison } from '../../src/v2/comparison.js';
it('keeps calibration phase and censored observations visible in comparisons', () => {
  const comparison = {
    manifestId: 'calibration',
    manifestHash: 'hash',
    phase: 'calibration',
    family: 'refund-accounting',
    fixtureVersion: 'refund-recovery-2',
    observationWindow: 5,
    cells: [
      {
        cell: 'lower/baseline',
        attempted: 3,
        scheduled: 3,
        valid: 3,
        triggerNotReached: 0,
        noResponseOpportunity: 1,
        opportunities: 2,
        retrieved: 0,
        neverRetrieved: 2,
        windowCensored: 0,
        functionalPass: 3,
        unfinishedAtCheckpoint: 1,
      },
    ],
    trials: [],
    pairedDifferences: [],
  } as unknown as Comparison;
  const html = renderToStaticMarkup(
    createElement(Experiments, { experiments: [comparison] }),
  );
  for (const text of [
    'calibration',
    'refund-recovery-2',
    'Window censored',
    'Never retrieved',
    'N/A',
    '3/3',
  ])
    expect(html).toContain(text);
});
