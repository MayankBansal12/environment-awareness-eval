import { NO_CONTEXT } from '../src/derive/context.js';
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
  type SupportedTraceSchemaVersion,
} from '../src/derive/trace-compat.js';
import { groupIntoBatches } from '../src/derive/batches.js';
import { environmentEventOf, slackThreadOf } from '../src/derive/slack.js';
import { decisionRangeOf, finalReportOf, turnRowsOf } from '../src/derive/turns.js';

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
    await readFile(path.join(runDir, 'summary.json'), 'utf8');
    return await readFile(path.join(runDir, 'trace.jsonl'), 'utf8');
  } catch {
    return null;
  }
}

async function loadCorpus(): Promise<RunBundle[]> {
  const entries = await readdir(resultsDir, { withFileTypes: true });
  const runs: RunBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const runDir = path.join(resultsDir, runId);
    // A run still being written has a trace but no summary yet. The production loader
    // quarantines those rather than failing; these helpers must be at least as tolerant,
    // or the suite goes red whenever it runs while a sweep is in flight.
    const raw = await readIfComplete(runDir);
    if (raw === null) continue;
    const trace: TraceEvent[] = [];
    const versions: SupportedTraceSchemaVersion[] = [];
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
      context: NO_CONTEXT,
      runId,
      summary,
      trace,
      reportMd: '',
      diff: '',
      workspacePath: workspacePathOf(trace),
      traceSchemaVersion: version,
      ticketDelivery:
        summaryTicket === undefined
          ? runStartDelivery !== undefined
            ? coerceTicketDelivery(runStartDelivery)
            : coerceTicketDelivery(undefined)
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
    // runs omit it. The recorded value always wins, including on non-test rows —
    // combined `pnpm test && git commit` commands are graded as commits but still
    // record the test result. Only the fallback path is phase-gated: unrecorded
    // outcomes are derived for test rows alone.
    for (const run of corpus) {
      const rows = actionRowsOf(run);
      for (const row of rows) {
        const recorded =
          row.event.type === 'tool_action' ? row.event.observedTestOutcome : undefined;
        if (row.phase !== 'test' && recorded === undefined) {
          expect(row.testOutcome, `${run.runId} action ${row.actionIndex}`).toBeNull();
          continue;
        }
        expect(row.testOutcome, `${run.runId} action ${row.actionIndex}`).not.toBeNull();
        if (recorded !== undefined) {
          expect(row.testOutcome, `${run.runId} action ${row.actionIndex}`).toBe(recorded);
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

describe('the slack channel across the corpus', () => {
  it('reconstructs a channel for every run whose ticket arrived over slack', () => {
    for (const run of corpus) {
      if (run.ticketDelivery !== 'slack') continue;
      const thread = slackThreadOf(run.trace);
      expect(thread.length, run.runId).toBeGreaterThan(0);
    }
  });

  it('never reports a message as perceived before it arrived', () => {
    for (const run of corpus) {
      for (const message of slackThreadOf(run.trace)) {
        for (const moment of [
          message.readAtDecision,
          message.indicatedAtDecision,
          message.exposedAtDecision,
        ]) {
          if (moment === null) continue;
          expect(
            moment,
            `${run.runId}/${message.messageId} perceived at D${moment} but arrived at D${message.arrivedAtDecision}`,
          ).toBeGreaterThanOrEqual(message.arrivedAtDecision);
        }
      }
    }
  });

  it('indicates before it exposes, whenever it does both', () => {
    // Under ambient delivery the status block precedes the read. A run where content
    // preceded its own indicator would mean the harness leaked the text early.
    for (const run of corpus) {
      for (const message of slackThreadOf(run.trace)) {
        if (message.indicatedAtDecision === null) continue;
        if (message.exposedAtDecision === null) continue;
        expect(
          message.exposedAtDecision,
          `${run.runId}/${message.messageId}`,
        ).toBeGreaterThanOrEqual(message.indicatedAtDecision);
      }
    }
  });

  it('agrees with the graded exposure decisions', () => {
    for (const run of corpus) {
      const event = environmentEventOf(slackThreadOf(run.trace));
      if (event === null) continue;
      const metrics = run.summary.grade.metrics as unknown as Record<string, unknown>;
      const indicator = metrics['indicatorDecision'];
      const content = metrics['contentDecision'];
      if (typeof indicator === 'number') {
        expect(event.indicatedAtDecision, `${run.runId} indicator`).toBe(indicator);
      }
      if (typeof content === 'number') {
        expect(event.exposedAtDecision, `${run.runId} content`).toBe(content);
      }
    }
  });

  it('finds exactly one injected environment event in every run that has one', () => {
    for (const run of corpus) {
      const events = slackThreadOf(run.trace).filter((entry) => entry.isEnvironmentEvent);
      expect(events.length, run.runId).toBeLessThanOrEqual(1);
    }
  });
});

describe('turn rows across the corpus', () => {
  it('accounts for every tool action exactly once', () => {
    for (const run of corpus) {
      const actions = actionRowsOf(run);
      const attached = turnRowsOf(run, actions).flatMap((turn) => turn.actions);
      expect(attached.length, run.runId).toBe(actions.length);
      expect(new Set(attached.map((action) => action.actionIndex)).size).toBe(
        actions.length,
      );
    }
  });

  it('keeps turns ordered on the logical clock', () => {
    for (const run of corpus) {
      const turns = turnRowsOf(run, actionRowsOf(run));
      for (let index = 1; index < turns.length; index += 1) {
        expect(turns[index]!.seq, run.runId).toBeGreaterThan(turns[index - 1]!.seq);
        expect(turns[index]!.decisionIndex, run.runId).toBeGreaterThanOrEqual(
          turns[index - 1]!.decisionIndex,
        );
      }
    }
  });

  it('groups tool actions without losing tool-free provider error turns', () => {
    // Provider errors and prose-only turns can outnumber tool actions. Every action
    // still belongs to exactly one turn, without dropping those tool-free decisions.
    for (const run of corpus) {
      const actions = actionRowsOf(run);
      const turns = turnRowsOf(run, actions);
      expect(
        turns.filter((turn) => turn.actions.length > 0).length,
        run.runId,
      ).toBeLessThanOrEqual(actions.length);
      expect(turns.flatMap((turn) => turn.actions).length, run.runId).toBe(actions.length);
    }
  });

  it('recovers the closing prose exactly when the trace recorded any', () => {
    // Not "every run has a final report": a run whose provider errored out can end with
    // `agent_finished` and no prose at all — `v4-m13-cancel-exposed` did, after three
    // error turns in five, and is graded invalid_run. Asserting a report there would be
    // asserting a fact about the corpus rather than about `finalReportOf`.
    for (const run of corpus) {
      const report = finalReportOf(turnRowsOf(run, actionRowsOf(run)));
      const hasProse = run.trace.some(
        (event) => event.type === 'assistant_turn' && event.text.trim() !== '',
      );
      expect(report.trim() !== '', run.runId).toBe(hasProse);
    }
  });

  it('still recovers closing prose for every run that completed its task', () => {
    const completed = corpus.filter((run) => run.summary.grade.valid);
    expect(completed.length).toBeGreaterThan(0);
    for (const run of completed) {
      const report = finalReportOf(turnRowsOf(run, actionRowsOf(run)));
      expect(report.trim(), run.runId).not.toBe('');
    }
  });

  it('keeps the cursor range inside the decisions the trace recorded', () => {
    for (const run of corpus) {
      const range = decisionRangeOf(run.trace);
      const turns = turnRowsOf(run, actionRowsOf(run));
      expect(range.min, run.runId).toBeLessThanOrEqual(range.max);
      for (const turn of turns) {
        expect(turn.decisionIndex, run.runId).toBeGreaterThanOrEqual(range.min);
        expect(turn.decisionIndex, run.runId).toBeLessThanOrEqual(range.max);
      }
    }
  });
});
