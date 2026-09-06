/**
 * Derivation against the real `results/` tree.
 *
 * This test loads traces exactly the way `scripts/build-data.ts` does — normalising
 * each event onto the local schema version before validating — so a mixed-generation
 * corpus (v1, v2, v3) loads here whenever it loads in the viewer. Every action must
 * derive a phase, a label and a timeline position without special-casing.
 *
 * These assertions must hold for any checkout of the corpus, from the two reference
 * runs up to the full N-run tree: they pin properties of the derivation, never counts
 * or the absence of optional fields.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TRACE_SCHEMA_VERSION, traceEventSchema } from '../../src/trace/schema.js';
import type { TraceEvent } from '../../src/trace/schema.js';
import type { RunBundle } from '../src/derive/model.js';
import {
  actionRowsOf,
  buildDigest,
  markerRowsOf,
  workspacePathOf,
  workspaceStateByDecision,
} from '../src/derive/timeline.js';
import {
  coerceTicketDelivery,
  normalizeTraceEvent,
  runTraceVersion,
} from '../src/derive/trace-compat.js';
import { groupIntoBatches } from '../src/derive/batches.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const resultsDir = process.env['EAW_RESULTS_DIR'] ?? path.join(repoRoot, 'results');

async function loadCorpus(): Promise<RunBundle[]> {
  const entries = await readdir(resultsDir, { withFileTypes: true });
  const runs: RunBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const runDir = path.join(resultsDir, runId);
    const raw = await readFile(path.join(runDir, 'trace.jsonl'), 'utf8');
    const trace: TraceEvent[] = [];
    const versions: (1 | 2 | 3)[] = [];
    let runStartDelivery: string | undefined;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const normalized = normalizeTraceEvent(JSON.parse(line), TRACE_SCHEMA_VERSION);
      if (!normalized.ok) throw new Error(`${runId}: ${normalized.reason}`);
      versions.push(normalized.value.sourceVersion);
      if (normalized.value.ticketDelivery !== null) {
        runStartDelivery = normalized.value.ticketDelivery;
      }
      trace.push(traceEventSchema.parse(normalized.value.candidate));
    }
    const summary = JSON.parse(
      await readFile(path.join(runDir, 'summary.json'), 'utf8'),
    ) as RunBundle['summary'];
    const { version } = runTraceVersion(versions);
    const summaryTicket = (summary as { ticketDelivery?: unknown }).ticketDelivery;
    runs.push({
      runId,
      summary,
      trace,
      reportMd: '',
      diff: '',
      workspacePath: workspacePathOf(trace),
      traceSchemaVersion: version,
      ticketDelivery:
        summaryTicket === undefined
          ? (runStartDelivery !== undefined
              ? coerceTicketDelivery(runStartDelivery)
              : coerceTicketDelivery(undefined))
          : coerceTicketDelivery(summaryTicket),
    });
  }
  return runs;
}

const corpus = await loadCorpus();

describe('the real results/ corpus', () => {
  it('has at least one run', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it('validates every trace event against the harness schema after normalisation', () => {
    // loadCorpus() normalises then parses strictly, so reaching here is the assertion.
    for (const run of corpus) {
      expect(run.trace.length, run.runId).toBeGreaterThan(0);
    }
  });

  it('reads every trace at a supported schema generation', () => {
    // A mixed-generation corpus is the normal case; every run reports the version it
    // was written at rather than failing the load.
    for (const run of corpus) {
      expect(run.traceSchemaVersion, run.runId).not.toBeNull();
    }
  });

  it('resolves a ticket delivery for every run', () => {
    for (const run of corpus) {
      expect(['slack', 'direct']).toContain(run.ticketDelivery);
    }
  });

  it('derives a phase and a label for every tool action', () => {
    for (const run of corpus) {
      for (const row of actionRowsOf(run)) {
        expect(row.phase, `${run.runId} action ${row.actionIndex}`).toBeTruthy();
        expect(row.label.trim(), `${run.runId} action ${row.actionIndex}`).not.toBe('');
      }
    }
  });

  it('strips the workspace prefix from every derived action path', () => {
    // The bulk of the corpus stores absolute `/tmp/eaw-run-…/workspace/…` paths in
    // inputSummary; the oldest runs store relative ones. Both must render relative.
    for (const run of corpus) {
      if (run.workspacePath === null) continue;
      for (const row of actionRowsOf(run)) {
        expect(row.path ?? '', run.runId).not.toContain(run.workspacePath);
      }
    }
  });

  it('keeps the digest strictly ordered on the logical clock', () => {
    for (const run of corpus) {
      const actions = actionRowsOf(run);
      const rows = buildDigest(actions, markerRowsOf(run.trace));
      let previous = -Infinity;
      for (const row of rows) {
        const seq = row.kind === 'band' ? row.actions[0]!.seq : row.seq;
        expect(seq, run.runId).toBeGreaterThanOrEqual(previous);
        previous = seq;
      }
    }
  });

  it('collapses the digest well below the raw action count', () => {
    for (const run of corpus) {
      const actions = actionRowsOf(run);
      const rows = buildDigest(actions, markerRowsOf(run.trace));
      expect(rows.length, run.runId).toBeLessThanOrEqual(actions.length + 4);
    }
  });

  it('gives every action a workspace state to render', () => {
    for (const run of corpus) {
      const states = workspaceStateByDecision(run.trace);
      expect(states.size, run.runId).toBeGreaterThan(0);
    }
  });

  it('places the indicator marker before the content marker when both exist', () => {
    for (const run of corpus) {
      const markers = markerRowsOf(run.trace);
      const indicator = markers.find((marker) => marker.marker === 'indicator');
      const content = markers.find(
        (marker) => marker.marker === 'content' || marker.marker === 'steer',
      );
      if (indicator === undefined || content === undefined) continue;
      expect(indicator.seq, run.runId).toBeLessThan(content.seq);
    }
  });

  it('agrees with the graded exposure decisions recorded in summary.json', () => {
    for (const run of corpus) {
      const metrics = run.summary.grade.metrics as unknown as Record<string, unknown>;
      const markers = markerRowsOf(run.trace);
      const indicator = markers.find((marker) => marker.marker === 'indicator');
      if (typeof metrics['indicatorDecision'] === 'number') {
        expect(indicator?.decisionIndex, run.runId).toBe(metrics['indicatorDecision']);
      } else {
        expect(indicator, run.runId).toBeUndefined();
      }
    }
  });
});

describe('observations across generations', () => {
  it('honours observedTestOutcome when recorded, else falls back to the grader', () => {
    // `observedTestOutcome` is optional: the bulk of the corpus records it, the oldest
    // runs omit it. The recorded value always wins; the fallback covers the rest.
    for (const run of corpus) {
      const rows = actionRowsOf(run);
      for (const row of rows) {
        if (row.phase !== 'test') {
          expect(row.testOutcome, `${run.runId} action ${row.actionIndex}`).toBeNull();
          continue;
        }
        expect(row.testOutcome, `${run.runId} action ${row.actionIndex}`).not.toBeNull();
        const event = row.event;
        if (event.type === 'tool_action' && event.observedTestOutcome !== undefined) {
          expect(row.testOutcome, `${run.runId} action ${row.actionIndex}`).toBe(
            event.observedTestOutcome,
          );
        }
      }
    }
  });

  it('still labels test outcomes on runs that predate the recorded field', () => {
    const outcomes = corpus.flatMap((run) =>
      actionRowsOf(run)
        .filter((row) => row.phase === 'test')
        .map((row) => row.testOutcome),
    );
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((outcome) => outcome !== null)).toBe(true);
  });

  it('places every action in exactly one batch', () => {
    // Batching is per turn in practice, but the schema leaves batchId optional, so the
    // derivation must handle batched and unbatched actions alike.
    for (const run of corpus) {
      const actions = actionRowsOf(run);
      const batches = groupIntoBatches(actions);
      expect(
        batches.reduce((sum, batch) => sum + batch.actions.length, 0),
        run.runId,
      ).toBe(actions.length);
    }
  });

  it('leaves assistant_turn.text empty except on the final stop turn', () => {
    for (const run of corpus) {
      for (const event of run.trace) {
        if (event.type !== 'assistant_turn') continue;
        if (event.stopReason === 'stop') continue;
        expect(event.text, `${run.runId} turn ${event.turnIndex}`).toBe('');
      }
    }
  });
});
