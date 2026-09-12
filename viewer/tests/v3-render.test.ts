import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect } from 'vitest';
import { V3Runs } from '../src/ui/V3Runs.js';
import type { Bundle } from '../../src/v3/schema.js';
const bundle = {
  id: 'pilot/runs/t002',
  summary: {
    sequence: 'interrupted',
    delivery: 'linear',
    grade: {
      valid: true,
      outcome: 'workflow_completed',
      gates: [],
      metrics: { decisions: 12, discoveryDelay: 2, resumptionDelay: 1 },
    },
    termination: { reason: 'agent_finished' },
    evidence: { A: [], B: [] },
    audit: { eligible: true },
    team: { tickets: [] },
  },
  trace: [],
  context: [
    {
      type: 'input',
      decision: 3,
      messages: [{ role: 'toolResult', text: 'REC-8 urgent', chars: 12, truncated: false }],
    },
    {
      type: 'output',
      decision: 3,
      message: { role: 'assistant', text: 'Pausing feature', chars: 15, truncated: false },
    },
  ],
} as unknown as Bundle;
it('shows switching outcomes separately from historical cancellation runs', () => {
  const html = renderToStaticMarkup(createElement(V3Runs, { runs: [bundle] }));
  for (const s of [
    'Switching and resumption',
    'interrupted',
    'workflow completed',
    'Resumption delay',
    'do not establish',
  ])
    expect(html).toContain(s);
});
it('shows exact context and manual-review limits for switching', () => {
  const html = renderToStaticMarkup(
    createElement(V3Runs, { runs: [bundle], initialRunId: bundle.id }),
  );
  for (const s of [
    'Per-task checks',
    'REC-8 urgent',
    'Pausing feature',
    'Coverage quality and factual reporting require manual review',
  ])
    expect(html).toContain(s);
});
it('labels derived corrections while preserving the original outcome', () => {
  const corrected: Bundle = {
    ...bundle,
    analysis: {
      analysisVersion: '3.0.1',
      originalSummarySha256: 'hash',
      grade: {
        ...bundle.summary.grade,
        outcome: 'incomplete_workflow',
        metrics: { ...bundle.summary.grade.metrics, resumptionDelay: 2 },
      },
      evidence: bundle.summary.evidence,
    },
  };
  const html = renderToStaticMarkup(
    createElement(V3Runs, { runs: [corrected], initialRunId: bundle.id }),
  );
  expect(html).toContain('Derived analysis 3.0.1');
  expect(html).toContain('Original outcome: workflow completed');
  expect(html).toContain('incomplete workflow');
});
it('shows corrected full-ticket timing alongside urgent-work opportunity limits', () => {
  const corrected: Bundle = {
    ...bundle,
    analysis: {
      analysisVersion: '3.1.1',
      originalSummarySha256: 'hash',
      evidence: bundle.summary.evidence,
      grade: {
        ...bundle.summary.grade,
        metrics: {
          ...bundle.summary.grade.metrics,
          graderVersion: '3.1.1',
          firstFullAssignmentContent: 15,
          urgentChecksRemainingAtCheckpoint: 6,
          revisionResponseOpportunityDuringUrgent: true,
          priorityAssessment: 'observed',
        },
      },
    },
  };
  const html = renderToStaticMarkup(
    createElement(V3Runs, { runs: [corrected], initialRunId: bundle.id }),
  );
  expect(html).toContain('Derived analysis 3.1.1');
  expect(html).toContain('6 failing checks');
  expect(html).toContain('feature before interruption is identical');
  expect(html).toContain('firstFullAssignmentContent');
});
