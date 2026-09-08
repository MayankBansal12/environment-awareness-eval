/**
 * Reads a `results/` tree, validates every trace event against the harness's own Zod
 * schema, and writes one JSON payload for Vite to inline.
 *
 * The tree is small enough to hold in memory in the browser all at once, so there is no
 * server, no database and no pagination anywhere in this viewer.
 *
 * Usage:
 *   tsx scripts/build-data.ts [--results <dir>]
 *   EAW_RESULTS_DIR=<dir> tsx scripts/build-data.ts
 *
 * The directory is an input, matching the runner's own `--results <dir>` flag, because
 * `results/` is gitignored apart from two force-added reference runs — the full corpus
 * lives wherever the operator ran the harness. It defaults to `<repo>/results`.
 *
 * Failure policy: a run that cannot be parsed is **quarantined**, not fatal. The corpus
 * spans three trace generations and will keep spanning more, so one unreadable run must
 * never stop the rest from rendering. Quarantined runs appear in the index with their
 * reason and are excluded from every aggregate; they are never silently dropped.
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceEventSchema, TRACE_SCHEMA_VERSION } from '../../src/trace/schema.js';
import type { TraceEvent } from '../../src/trace/schema.js';
import type { EvalSummary } from '../../src/runner.js';
import type {
  LoadWarning,
  QuarantinedRun,
  RunBundle,
  ViewerData,
} from '../src/derive/model.js';
import { BlobInterner, loadContextBundle } from '../src/derive/context-load.js';
import {
  coerceTicketDelivery,
  normalizeTraceEvent,
  runTraceVersion,
  SUPPORTED_TRACE_SCHEMA_VERSIONS,
  type SupportedTraceSchemaVersion,
  type TicketDelivery,
} from '../src/derive/trace-compat.js';

const viewerRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(viewerRoot, '..');
const outputPath = path.join(viewerRoot, 'src', 'generated', 'data.json');

/** Thrown per run, caught per run. Never aborts the build. */
class RunUnreadable extends Error {
  constructor(
    message: string,
    readonly claimedVersion: number | null,
  ) {
    super(message);
  }
}

/** `--results <dir>` beats `EAW_RESULTS_DIR`, which beats `<repo>/results`. */
function resolveResultsDir(argv: readonly string[]): string {
  const flag = argv.indexOf('--results');
  if (flag !== -1) {
    const value = argv[flag + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--results requires a directory path');
    }
    return path.resolve(value);
  }
  const fromEnv = process.env['EAW_RESULTS_DIR'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.join(repoRoot, 'results');
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function claimedVersionOf(raw: string): number | null {
  const firstLine = raw.split('\n').find((line) => line.trim() !== '');
  if (firstLine === undefined) return null;
  try {
    const value = (JSON.parse(firstLine) as { schemaVersion?: unknown }).schemaVersion;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

interface ParsedTrace {
  events: TraceEvent[];
  versions: SupportedTraceSchemaVersion[];
  ticketDelivery: TicketDelivery | null;
}

function parseTrace(runId: string, raw: string): ParsedTrace {
  const events: TraceEvent[] = [];
  const versions: SupportedTraceSchemaVersion[] = [];
  let ticketDelivery: TicketDelivery | null = null;

  for (const [index, line] of raw.split('\n').entries()) {
    const text = line.trim();
    if (text === '') continue;
    const where = `${runId}/trace.jsonl:${index + 1}`;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new RunUnreadable(`${where} is not valid JSON: ${String(error)}`, null);
    }

    // Reconcile the version literal before validating, so v1, v2 and v3 traces can sit in
    // one corpus without any generation being rejected outright.
    const normalized = normalizeTraceEvent(json, TRACE_SCHEMA_VERSION);
    if (!normalized.ok) {
      throw new RunUnreadable(`${where}: ${normalized.reason}`, claimedVersionOf(text));
    }
    versions.push(normalized.value.sourceVersion);
    if (normalized.value.ticketDelivery !== null) {
      ticketDelivery = normalized.value.ticketDelivery;
    }

    const parsed = traceEventSchema.safeParse(normalized.value.candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      const type = (json as { type?: unknown }).type;
      throw new RunUnreadable(
        `${where} (type=${String(type)}, written at v${normalized.value.sourceVersion}) ` +
          `does not match traceEventSchema v${TRACE_SCHEMA_VERSION}: ${issues}`,
        normalized.value.sourceVersion,
      );
    }
    events.push(parsed.data);
  }

  return { events, versions, ticketDelivery };
}

async function loadRun(
  resultsDir: string,
  runId: string,
  warnings: LoadWarning[],
  interner: BlobInterner,
): Promise<RunBundle> {
  const runDir = path.join(resultsDir, runId);

  const traceRaw = await readIfPresent(path.join(runDir, 'trace.jsonl'));
  const summaryRaw = await readIfPresent(path.join(runDir, 'summary.json'));
  if (traceRaw === null || summaryRaw === null) {
    throw new RunUnreadable(
      `${traceRaw === null ? 'trace.jsonl' : 'summary.json'} is missing`,
      null,
    );
  }

  let summary: EvalSummary;
  try {
    summary = JSON.parse(summaryRaw) as EvalSummary;
  } catch (error) {
    throw new RunUnreadable(`summary.json is not valid JSON: ${String(error)}`, null);
  }

  const { events, versions, ticketDelivery } = parseTrace(runId, traceRaw);
  const { version, mixed } = runTraceVersion(versions);

  if (mixed) {
    warnings.push({
      runId,
      kind: 'mixed_trace_versions',
      message:
        `trace.jsonl mixes schema versions (${[...new Set(versions)].join(', ')}). A ` +
        `trace is written by one runner in one pass, so this indicates a concatenated ` +
        `or corrupted artifact rather than ordinary version spread.`,
    });
  }

  const fixture = events.find((event) => event.type === 'fixture_prepared');
  const summaryTicket = (summary as { ticketDelivery?: unknown }).ticketDelivery;

  // Read against the trace's own decision count, so a sidecar that is short can say how
  // short rather than merely ending early. A missing or unreadable sidecar is never fatal:
  // 56 runs in the corpus predate the capture entirely and must keep rendering.
  const context = loadContextBundle(
    await readIfPresent(path.join(runDir, 'context.jsonl')),
    {
      expectedRunId: runId,
      traceDecisions: events
        .filter((event) => event.type === 'decision_boundary')
        .map((event) => ({
          decisionIndex: event.decisionIndex,
          contextMessageCount: event.contextMessageCount,
        })),
      traceDecisionCount: new Set(
        events
          .filter((event) => event.type === 'decision_boundary')
          .map((event) => event.decisionIndex),
      ).size,
      interner,
    },
  );
  if (context.fidelity.level === 'unreadable') {
    warnings.push({
      runId,
      kind: 'context_unreadable',
      message: `context.jsonl: ${context.fidelity.limitations.join(' ')}`,
    });
  }

  return {
    context,
    runId,
    summary,
    trace: events,
    reportMd: (await readIfPresent(path.join(runDir, 'report.md'))) ?? '',
    diff: (await readIfPresent(path.join(runDir, 'workspace.diff'))) ?? '',
    workspacePath: fixture?.type === 'fixture_prepared' ? fixture.workspacePath : null,
    traceSchemaVersion: version,
    // The summary is authoritative when it carries the field; otherwise fall back to
    // run_start, and finally to the documented `slack` default. Summary schemaVersion
    // itself spans 1–3 across the corpus, which is normal spread and is not warned about.
    ticketDelivery:
      summaryTicket === undefined
        ? (ticketDelivery ?? coerceTicketDelivery(undefined))
        : coerceTicketDelivery(summaryTicket),
  };
}

async function main(): Promise<void> {
  const resultsDir = resolveResultsDir(process.argv.slice(2));

  let entries: string[] = [];
  try {
    const dirents = await readdir(resultsDir, { withFileTypes: true });
    entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // An absent or unreadable results directory is an empty corpus, not a crash: the
    // viewer still builds and renders an empty state explaining where it looked.
    console.warn(`[viz] results directory not readable: ${resultsDir}`);
  }
  entries.sort();

  const warnings: LoadWarning[] = [];
  const runs: RunBundle[] = [];
  const quarantined: QuarantinedRun[] = [];
  // One table for the whole corpus. A sweep runs the same system prompt, the same tool
  // schemas and the same opening user message through every run, so sharing across runs is
  // where most of the saving is.
  const interner = new BlobInterner();

  for (const runId of entries) {
    try {
      runs.push(await loadRun(resultsDir, runId, warnings, interner));
    } catch (error) {
      if (error instanceof RunUnreadable) {
        quarantined.push({
          runId,
          claimedVersion: error.claimedVersion,
          reason: error.message,
        });
        continue;
      }
      throw error;
    }
  }

  const data: ViewerData = {
    generatedAtIso: new Date().toISOString(),
    resultsDir,
    localTraceSchemaVersion: TRACE_SCHEMA_VERSION,
    runs,
    quarantined,
    warnings,
    blobs: interner.table(),
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(data), 'utf8');

  const bytes = (await stat(outputPath)).size;
  const events = runs.reduce((sum, run) => sum + run.trace.length, 0);
  const captured = runs.filter((run) => run.context.fidelity.level !== 'none');
  const capturedCalls = captured.reduce((sum, run) => sum + run.context.calls.length, 0);
  const byVersion = new Map<string, number>();
  for (const run of runs) {
    const key = `v${String(run.traceSchemaVersion ?? '?')}`;
    byVersion.set(key, (byVersion.get(key) ?? 0) + 1);
  }

  console.log(`[viz] results dir: ${resultsDir}`);
  console.log(
    `[viz] ${runs.length} run(s), ${events} trace events validated against ` +
      `traceEventSchema v${TRACE_SCHEMA_VERSION} ` +
      `(reads v${SUPPORTED_TRACE_SCHEMA_VERSIONS.join('/v')}) → ` +
      `${(bytes / 1_048_576).toFixed(2)} MB inlined`,
  );
  console.log(
    `[viz] captured context: ${captured.length}/${runs.length} run(s), ` +
      `${capturedCalls} model call(s), interned into ${interner.size} unique ` +
      `bodies (${(interner.chars / 1_048_576).toFixed(2)} MB of text)`,
  );
  for (const run of captured) {
    if (run.context.fidelity.level === 'full') continue;
    console.log(
      `[viz]   ${run.runId}: ${run.context.fidelity.level} — ` +
        run.context.fidelity.limitations.join(' | '),
    );
  }
  if (byVersion.size > 0) {
    console.log(
      `[viz] traces by version: ` +
        [...byVersion.entries()]
          .sort()
          .map(([key, count]) => `${key}×${count}`)
          .join(', '),
    );
  }
  if (runs.length === 0) {
    console.warn(
      `[viz] no runs loaded — the viewer will render an empty state. Point it at the ` +
        `full corpus with: pnpm viz --results <dir>`,
    );
  }
  for (const run of quarantined) {
    console.warn(`[viz] QUARANTINED ${run.runId}: ${run.reason}`);
  }
  for (const warning of warnings) {
    console.warn(`[viz] warning ${warning.runId}: ${warning.message}`);
  }
}

main().catch((error: unknown) => {
  console.error(`[viz] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
