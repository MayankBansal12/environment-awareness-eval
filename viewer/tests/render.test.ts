import { NO_CONTEXT } from '../src/derive/context.js';
/**
 * Render smoke test for the cockpit, over the whole real corpus.
 *
 * The other suites test derivation; this one tests that the panes survive contact with
 * every run in `results/`. That is a different failure mode and the one a reader actually
 * hits: a run with no exposure, no Slack traffic, a single decision or a v1 trace missing
 * a field will crash a pane that assumed otherwise, and no amount of derivation testing
 * catches it.
 *
 * `createElement` is used instead of JSX so this file stays a plain `.ts` and matches the
 * suite's existing include pattern. Static markup is enough: `useEffect` not running under
 * SSR is fine, because the initial state is exactly the state a reader first sees.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TRACE_SCHEMA_VERSION, traceEventSchema } from '../../src/trace/schema.js';
import type { TraceEvent } from '../../src/trace/schema.js';
import type { RunBundle } from '../src/derive/model.js';
import { workspacePathOf } from '../src/derive/timeline.js';
import {
  coerceTicketDelivery,
  normalizeTraceEvent,
  runTraceVersion,
  type SupportedTraceSchemaVersion,
} from '../src/derive/trace-compat.js';
import { Cockpit } from '../src/ui/Cockpit.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const resultsDir = process.env['EAW_RESULTS_DIR'] ?? path.join(repoRoot, 'results');

/**
 * Reads a run's trace only when the run finished writing.
 *
 * `summary.json` is written last, so its absence marks a run that is mid-flight or was
 * killed. Returning null skips it, matching how `build-data.ts` quarantines such runs
 * instead of aborting the whole corpus.
 */
async function readIfComplete(runDir: string): Promise<string | null> {
  try {
    const metadata = JSON.parse(
      await readFile(path.join(runDir, 'summary.json'), 'utf8'),
    ) as { format?: string };
    if (metadata.format === 'environment-v2') return null;
    return await readFile(path.join(runDir, 'trace.jsonl'), 'utf8');
  } catch {
    return null;
  }
}

async function loadCorpus(): Promise<RunBundle[]> {
  const entries = await readdir(resultsDir, { withFileTypes: true }).catch(() => []);
  const runs: RunBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(resultsDir, entry.name);
    const raw = await readIfComplete(runDir);
    if (raw === null) continue;
    const trace: TraceEvent[] = [];
    const versions: SupportedTraceSchemaVersion[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const normalized = normalizeTraceEvent(JSON.parse(line), TRACE_SCHEMA_VERSION);
      if (!normalized.ok) throw new Error(`${entry.name}: ${normalized.reason}`);
      versions.push(normalized.value.sourceVersion);
      trace.push(traceEventSchema.parse(normalized.value.candidate));
    }
    const summary = JSON.parse(
      await readFile(path.join(runDir, 'summary.json'), 'utf8'),
    ) as RunBundle['summary'];
    runs.push({
      context: NO_CONTEXT,
      runId: entry.name,
      summary,
      trace,
      reportMd: '',
      diff: '',
      workspacePath: workspacePathOf(trace),
      traceSchemaVersion: runTraceVersion(versions).version,
      ticketDelivery: coerceTicketDelivery(
        (summary as { ticketDelivery?: unknown }).ticketDelivery,
      ),
    });
  }
  return runs.sort((a, b) => a.runId.localeCompare(b.runId));
}

const corpus = await loadCorpus();

function render(run: RunBundle, siblings: readonly RunBundle[]): string {
  return renderToStaticMarkup(
    createElement(Cockpit, { run, siblings, onSelectRun: () => {} }),
  );
}

describe.skipIf(corpus.length === 0)('cockpit rendering', () => {
  it('renders every run in the corpus without throwing', () => {
    for (const run of corpus) {
      const siblings = corpus.filter(
        (entry) => entry.summary.runtime.model === run.summary.runtime.model,
      );
      expect(() => render(run, siblings), `run ${run.runId}`).not.toThrow();
    }
  });

  it('shows the four panes', () => {
    const run = corpus[0];
    expect(run).toBeDefined();
    const html = render(run!, corpus);
    expect(html).toContain('test cases');
    expect(html).toContain('Agent overview');
    expect(html).toContain('Terminal &amp; tool logs');
    expect(html).toContain('Slack workspace');
    expect(html).toContain('Whole-run summary');
    expect(html).toContain('environment at this decision');
    expect(html).toContain('Model call inspector');
  });

  it('renders the run that carries the ticket over the user prompt', () => {
    // `verify-direct-cancel-exposed` is the only `direct` delivery in the corpus, so its
    // channel opens without the ticket message every other run starts from.
    const direct = corpus.find((run) => run.ticketDelivery === 'direct');
    if (direct === undefined) return;
    expect(() => render(direct, [direct])).not.toThrow();
  });

  it('places the environment event text in the channel once it has been exposed', () => {
    const run = corpus.find((entry) => entry.runId.endsWith('cancel-steer'));
    expect(run).toBeDefined();
    const html = render(run!, [run!]);
    // The cursor starts at the end of the run, so a steered cancellation must be rendered
    // as perceived rather than as an unread the agent never saw.
    expect(html).toContain('text placed in context');
  });

  it('attributes missing reasoning to the trace generation, not to the model', () => {
    // Every run in the corpus predates v4, so the pane must say the harness never
    // recorded reasoning rather than implying the model produced none.
    const run = corpus.find((entry) => (entry.traceSchemaVersion ?? 0) < 4);
    expect(run).toBeDefined();
    const html = render(run!, [run!]);
    expect(html).toContain('predates reasoning capture');
  });
});
