import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextSchema } from '../../src/schema.js';
import { loadResults } from '../scripts/build-data.js';
import { writeFixtures } from '../scripts/fixtures.js';
import {
  decisionRows,
  filterRuns,
  inputMessages,
  NO_FILTERS,
  trendGroups,
} from '../src/derive.js';
import type { RunDetail, ViewerIndex } from '../src/model.js';
import { capturedContext } from '../src/derive/capture.js';
import { indicatorDecision, slackThreadOf, visibilityAt } from '../src/derive/slack.js';
import { actionRowsOf } from '../src/derive/timeline.js';
import { Comparison } from '../src/ui/Compare.js';
import { RunView } from '../src/ui/Cockpit.js';
import { ExperimentView } from '../src/ui/ExperimentView.js';
import { RunList } from '../src/ui/RunList.js';

let dir: string;
let index: ViewerIndex;
let details: RunDetail[];
const run = (key: string) => details.find((d) => d.key === key)!;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'eaw-viewer-'));
  await writeFixtures(dir);
  await mkdir(path.join(dir, 'old-v3'));
  await writeFile(path.join(dir, 'old-v3', 'manifest.json'), '{"version":"3.0"}');
  ({ index, details } = await loadResults(dir));
}, 120_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('loading', () => {
  it('finds experiment and ad hoc runs and skips other formats', () => {
    expect(index.experiments.map((e) => e.id).sort()).toEqual([
      'fixture-controls',
      'fixture-load-sweep',
    ]);
    expect(index.runs).toHaveLength(33);
    expect(index.runs.filter((r) => r.experiment === null).map((r) => r.key)).toEqual([
      'dev/fulfillment-high-heavy',
      'dev/settlement-heavy-exposed',
    ]);
    expect(index.skipped).toEqual([
      { path: 'old-v3', reason: 'manifest.json is not a v4 manifest' },
    ]);
  });

  it('interns captured inputs without losing any message', async () => {
    const r = run('fixture-load-sweep/runs/t003');
    const raw = (await readFile(path.join(dir, r.key, 'context.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => contextSchema.parse(JSON.parse(l)));
    for (const c of raw)
      if (c.type === 'input')
        expect(inputMessages(r, c.decision).map((m) => m.message)).toEqual(c.messages);
    expect(r.header?.tools.map((t) => t.name)).toContain('linear_inbox');
    expect(r.capture?.complete).toBe(true);
  });
});

describe('decision timeline', () => {
  it('agrees with the grade for every run', () => {
    for (const r of details) {
      const rows = decisionRows(r.trace);
      const s = r.summary;
      expect(rows.map((x) => x.decision)).toEqual(rows.map((_, i) => i + 1));
      expect(rows).toHaveLength(s.usage.turnCalls);
      for (const e of s.grade.events.filter((e) => e.fired)) {
        expect(rows[e.firedDecision! - 1]!.fired.map((f) => f.eventId)).toContain(
          e.eventId,
        );
        if (e.contentDecision !== null)
          expect(rows[e.contentDecision - 1]!.exposures).toContainEqual(
            expect.objectContaining({ eventId: e.eventId, level: 'content' }),
          );
      }
      const noise = rows.flatMap((x) => x.fired).filter((f) => f.kind === 'noise');
      expect(noise).toHaveLength(s.grade.summary['noiseEvents']!);
      expect(rows.reduce((n, x) => n + x.commits, 0)).toBe(s.finalWorkspace.commits.length);
      const summaryCalls = s.usage.summaryCalls ? 1 : 0;
      if (!summaryCalls) expect(rows.at(-1)!.cumulativeTokens).toBe(s.usage.totalTokens);
      else expect(rows.some((x) => x.compaction)).toBe(true);
    }
  });

  it('marks retries, test failures, hotfix work and unread counts', () => {
    const failed = decisionRows(run('fixture-load-sweep/runs/t005').trace);
    expect(failed.at(-1)).toMatchObject({ retries: 4, stopReason: 'error' });
    const rows = decisionRows(run('fixture-load-sweep/runs/t018').trace);
    expect(rows.some((x) => x.testFailure)).toBe(true);
    expect(rows.some((x) => x.hotfixEdit)).toBe(true);
    expect(rows.some((x) => x.focalEdit)).toBe(true);
    const urgent = run('fixture-load-sweep/runs/t018').summary.grade.events[1]!;
    expect(rows[urgent.firedDecision!]!.unread.slack).toBeGreaterThan(0);
  });
});

describe('aggregates', () => {
  it('filters runs by condition', () => {
    const high = filterRuns(index.runs, { ...NO_FILTERS, load: 'high' });
    expect(high.length).toBeGreaterThan(0);
    expect(high.every((r) => r.condition.load === 'high')).toBe(true);
    expect(filterRuns(index.runs, { ...NO_FILTERS, experiment: 'dev' })).toHaveLength(2);
  });

  it('groups load-sweep cells into low → high trends', () => {
    const sweep = index.experiments.find((e) => e.id === 'fixture-load-sweep')!.comparison;
    const groups = trendGroups(sweep);
    expect(groups.map((g) => g.key)).toEqual([
      'fulfillment/normal/ambient',
      'settlement/normal/ambient',
    ]);
    for (const g of groups)
      expect(Object.keys(g.byLoad).sort()).toEqual(['high', 'low', 'medium']);
    const controls = index.experiments.find((e) => e.id === 'fixture-controls')!.comparison;
    expect(
      trendGroups(controls).every((g) => Object.keys(g.byLoad).join() === 'high'),
    ).toBe(true);
  });
});

describe('rendering', () => {
  it('renders the run list, cockpit and experiment view', () => {
    const list = renderToStaticMarkup(
      createElement(RunList, { index, query: new URLSearchParams('noise=heavy') }),
    );
    expect(list).toContain('2 of 33 runs');
    const missed = details.find((d) => d.summary.grade.events.some((e) => e.missed))!;
    const cockpit = renderToStaticMarkup(
      createElement(RunView, { run: missed, decision: 2 }),
    );
    expect(cockpit).toContain('Model call · D2');
    expect(cockpit).toContain('missed');
    expect(cockpit).toContain('environment_status');
    const experiment = renderToStaticMarkup(
      createElement(ExperimentView, { index, id: 'fixture-load-sweep' }),
    );
    expect(experiment).toContain('Missed rate (95% CI)');
    expect(experiment).toContain('settlement/high/normal/ambient');
  });
});

describe('restored cockpit on v4 artifacts', () => {
  it('replays important update knowledge without leaking final read states', () => {
    for (const r of details) {
      const messages = slackThreadOf(r);
      for (const metric of r.summary.grade.events.filter((e) => e.fired)) {
        const related = messages.filter((m) => m.eventId === metric.eventId && !m.cueOnly);
        expect(related.length).toBeGreaterThan(0);
        const indicator = indicatorDecision(r, metric.eventId);
        if (indicator !== null) expect(indicator).toBe(metric.firedDecision! + 1);
        for (const message of related) {
          expect(visibilityAt(message, metric.firedDecision! - 1)).toBe('unsent');
          expect(visibilityAt(message, metric.firedDecision!)).toBe('unread');
          if (metric.contentDecision !== null) {
            expect(['read', 'exposed']).not.toContain(
              visibilityAt(message, metric.contentDecision - 1),
            );
            expect(visibilityAt(message, metric.contentDecision)).toBe(
              r.summary.condition.delivery === 'exposed' ? 'exposed' : 'read',
            );
          } else
            expect(['read', 'exposed']).not.toContain(
              visibilityAt(message, r.summary.usage.turnCalls),
            );
        }
      }
    }
  });

  it('distinguishes a retrieved Slack ping from authoritative Linear requirements', () => {
    const r = run('fixture-load-sweep/runs/t018');
    const urgent = r.summary.grade.events.find((e) => e.kind === 'urgent_assignment')!;
    const messages = slackThreadOf(r).filter((m) => m.eventId === urgent.eventId);
    const ping = messages.find((m) => m.source === 'slack')!;
    const ticket = messages.find((m) => m.source === 'linear')!;
    expect(ping.cueOnly).toBe(true);
    expect(ping.readAtDecision).not.toBeNull();
    expect(ping.readAtDecision!).toBeLessThan(urgent.contentDecision!);
    expect(visibilityAt(ping, ping.readAtDecision! - 1)).toBe('unread');
    expect(visibilityAt(ping, ping.readAtDecision!)).toBe('read');
    expect(visibilityAt(ticket, ping.readAtDecision!)).toBe('indicated');
    expect(visibilityAt(ticket, urgent.contentDecision!)).toBe('read');
  });

  it('preserves captured order, structured blocks and tool arguments in the original inspector', () => {
    const r = run('fixture-load-sweep/runs/t018');
    const { bundle, blobs } = capturedContext(r);
    expect(bundle.fidelity.level).toBe('full');
    expect(blobs[bundle.header!.systemPromptRef]).toBe(r.header!.systemPrompt);
    for (const call of bundle.calls) {
      const original = inputMessages(r, call.decisionIndex).map((m) => m.message);
      expect(call.input!.messages.map((m) => blobs[m.textRef])).toEqual(
        original.map((m) => m.text),
      );
      expect(call.input!.messages.map((m) => m.blocks?.map((b) => b.kind))).toEqual(
        original.map((m) => m.blocks?.map((b) => b.kind)),
      );
      for (const tool of call.output?.toolCalls ?? []) {
        const originalTool = r.outputs[call.decisionIndex]!.blocks!.find(
          (b) => b.kind === 'toolCall' && b.id === tool.id,
        );
        expect(originalTool?.kind).toBe('toolCall');
        if (originalTool?.kind === 'toolCall')
          expect(JSON.parse(blobs[tool.argumentsRef]!)).toEqual(originalTool.arguments);
      }
    }
    const missing = structuredClone(r);
    delete missing.outputs[2];
    const partial = capturedContext(missing).bundle;
    expect(partial.fidelity.level).toBe('partial');
    expect(partial.calls.find((c) => c.decisionIndex === 2)?.output).toBeNull();
    expect(partial.fidelity.limitations.join(' ')).toContain('Missing outputs: 2');
  });

  it('keeps terminal output readable and renders the original panes and aligned comparison', () => {
    const r = run('fixture-load-sweep/runs/t018');
    const shell = actionRowsOf(r).find((a) => a.toolName === 'bash')!;
    expect(shell.outputPreview).toBe(
      (shell.event.observation.value as { stdout: string }).stdout,
    );
    const cockpit = renderToStaticMarkup(
      createElement(RunView, { run: r, decision: null, siblings: index.runs }),
    );
    for (const pane of [
      'railpane',
      'activitypane',
      'terminalpane',
      'slackpane',
      'scrubber',
      'model-inspector',
    ])
      expect(cockpit).toContain(pane);
    expect(cockpit).toContain(`value="${r.summary.usage.turnCalls}"`);
    const shorter = run('fixture-load-sweep/runs/t005');
    const comparison = renderToStaticMarkup(
      createElement(Comparison, { a: r, b: shorter }),
    );
    expect(comparison).toContain('No decision in this run');
    expect(comparison.match(/class="compare-decision"/g)).toHaveLength(
      r.summary.usage.turnCalls,
    );
    expect(comparison.indexOf('Requirement change fired')).toBeGreaterThanOrEqual(0);
    expect(comparison.indexOf('Requirement change fired')).toBeLessThan(
      comparison.indexOf('edit src/money.mjs'),
    );
  });
});
