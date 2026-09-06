/**
 * Tests for the viewer's derivation logic only — phase labelling, batch grouping, path
 * stripping, metric extraction and trace-version normalisation. React rendering is
 * deliberately not tested.
 */

import { describe, expect, it } from 'vitest';

import { COMMIT_PATTERN, TEST_PATTERN } from '../../src/grading/grader.js';
import { traceEventSchema, TRACE_SCHEMA_VERSION } from '../../src/trace/schema.js';
import type { TraceEvent } from '../../src/trace/schema.js';
import { batchSizes, groupIntoBatches } from '../src/derive/batches.js';
import {
  DEFAULT_TICKET_DELIVERY,
  formatAfterContent,
  formatIndicatorToContent,
  groupRuns,
  isValid,
  roundFromRunId,
  ticketDeliveryOf,
} from '../src/derive/metrics.js';
import type { ActionRow, RunBundle } from '../src/derive/model.js';
import {
  basename,
  dirname,
  stripWorkspacePrefix,
  stripWorkspacePrefixEverywhere,
} from '../src/derive/paths.js';
import {
  actionLabel,
  actionPath,
  classifyBash,
  phaseForAction,
  testOutcomeFor,
} from '../src/derive/phases.js';
import {
  environmentEventOf,
  isPerceived,
  slackThreadOf,
  visibilityAt,
} from '../src/derive/slack.js';
import { describeComposition, describeTargets } from '../src/derive/timeline.js';
import {
  decisionRangeOf,
  finalReportOf,
  reasoningStateOf,
  turnRowsOf,
} from '../src/derive/turns.js';
import {
  coerceTicketDelivery,
  normalizeTraceEvent,
  runTraceVersion,
} from '../src/derive/trace-compat.js';

/* ------------------------------------------------- grader pattern agreement */

describe('grader pattern agreement', () => {
  it('labels bash through the grader’s own exported regexes, not restated copies', () => {
    // `phases.ts` imports TEST_PATTERN / COMMIT_PATTERN from the grader, so these
    // assertions pin the shared behaviour: if the grader’s literals change, the
    // viewer’s labels change with them instead of silently disagreeing.
    expect(TEST_PATTERN.test('pnpm test')).toBe(true);
    expect(TEST_PATTERN.test('npx vitest run tests/x.test.ts')).toBe(true);
    expect(COMMIT_PATTERN.test('git commit -m "fix"')).toBe(true);
    expect(COMMIT_PATTERN.test('git status --short')).toBe(false);
    expect(classifyBash('pnpm test')).toBe('test');
    expect(classifyBash('git commit -m "fix"')).toBe('commit');
  });
});

/* --------------------------------------------------------------- bash phases */

describe('bash classification', () => {
  it('classifies test commands', () => {
    expect(classifyBash('pnpm test')).toBe('test');
    expect(classifyBash('pnpm test && pnpm typecheck')).toBe('test');
    expect(classifyBash('npx vitest run tests/x.test.ts')).toBe('test');
  });

  it('classifies commit commands exactly as the grader counts them', () => {
    expect(classifyBash('git commit -m "fix"')).toBe('commit');
    expect(COMMIT_PATTERN.test('git commit -m "fix"')).toBe(true);
    // The grader's pattern only allows dash-flags between `git` and `commit`, so a
    // `-c key=value` assignment is not a commit attempt in its metrics — and must not
    // be one in the timeline either. Parity beats cleverness here.
    expect(classifyBash('git -c user.name=x commit -m "fix"')).toBe('shell');
    expect(COMMIT_PATTERN.test('git -c user.name=x commit -m "fix"')).toBe(false);
  });

  it('treats anything else as a plain shell command', () => {
    expect(classifyBash('pnpm typecheck')).toBe('shell');
    expect(classifyBash('git status --short')).toBe('shell');
    expect(classifyBash('git diff --check')).toBe('shell');
  });

  it('calls a combined test-and-commit a commit, matching the grader metric', () => {
    // The grader counts this as a commit attempt; the label must not disagree.
    const command =
      'git add src && git commit -m "Fix refund request idempotency" && git status --short';
    expect(classifyBash(command)).toBe('commit');
    expect(classifyBash('pnpm test && git commit -m x')).toBe('commit');
  });
});

/* -------------------------------------------------------------- phase labels */

describe('phase labelling', () => {
  it('maps each tool to its phase', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['read', { path: 'src/x.ts' }, 'explore'],
      ['ls', { path: '.' }, 'explore'],
      ['find', { path: '.', pattern: '*' }, 'explore'],
      ['grep', { pattern: 'refund' }, 'explore'],
      ['edit', { path: 'src/x.ts', editCount: 2 }, 'modify'],
      ['write', { path: 'src/x.ts', contentBytes: 40 }, 'modify'],
      ['read_slack_messages', {}, 'inspect'],
      ['post_slack_message', { text: 'done' }, 'report'],
      ['bash', { command: 'pnpm test' }, 'test'],
      ['bash', { command: 'git commit -m x' }, 'commit'],
      ['bash', { command: 'ls -la' }, 'shell'],
    ];
    for (const [tool, summary, expected] of cases) {
      expect(phaseForAction(tool, summary), `${tool} ${JSON.stringify(summary)}`).toBe(
        expected,
      );
    }
  });

  it('falls back to shell for an unknown tool and for bash with no command', () => {
    expect(phaseForAction('mystery_tool', {})).toBe('shell');
    expect(phaseForAction('bash', {})).toBe('shell');
  });
});

describe('action labels', () => {
  const ws = '/tmp/eaw-run-x-AbCdEf/workspace';

  it('renders each inputSummary shape found in the corpus', () => {
    expect(actionLabel({ toolName: 'read', inputSummary: { path: 'src/x.ts' } }, ws).label).toBe(
      'read src/x.ts',
    );
    expect(actionLabel({ toolName: 'ls', inputSummary: { path: '.' } }, ws).label).toBe('ls .');
    expect(
      actionLabel({ toolName: 'edit', inputSummary: { path: 'a.ts', editCount: 3 } }, ws),
    ).toEqual({ label: 'edit a.ts', detail: '3 edits' });
    expect(
      actionLabel({ toolName: 'edit', inputSummary: { path: 'a.ts', editCount: 1 } }, ws).detail,
    ).toBe('1 edit');
    expect(
      actionLabel({ toolName: 'write', inputSummary: { path: 'a.ts', contentBytes: 12 } }, ws),
    ).toEqual({ label: 'write a.ts', detail: '12 B' });
    expect(
      actionLabel({ toolName: 'find', inputSummary: { path: '.', pattern: '*' } }, ws).label,
    ).toBe('find . /*/');
    expect(
      actionLabel({ toolName: 'grep', inputSummary: { pattern: 'refund' } }, ws).label,
    ).toBe('grep /refund/');
    expect(
      actionLabel({ toolName: 'bash', inputSummary: { command: 'pnpm test' } }, ws).label,
    ).toBe('bash pnpm test');
    expect(
      actionLabel({ toolName: 'post_slack_message', inputSummary: { text: 'hi' } }, ws),
    ).toEqual({ label: 'post_slack_message', detail: 'hi' });
    expect(
      actionLabel({ toolName: 'read_slack_messages', inputSummary: {} }, ws).label,
    ).toBe('read_slack_messages');
  });

  it('strips the workspace prefix from an absolute path', () => {
    expect(
      actionPath({ toolName: 'read', inputSummary: { path: `${ws}/src/x.ts` } }, ws),
    ).toBe('src/x.ts');
  });

  it('returns null when the action has no path', () => {
    expect(actionPath({ toolName: 'bash', inputSummary: { command: 'ls' } }, ws)).toBeNull();
  });
});

/* ------------------------------------------------------------ test outcomes */

describe('test outcome', () => {
  const base = { toolName: 'bash', isError: false, outputPreview: '' };

  it('prefers the recorded observedTestOutcome when present', () => {
    expect(testOutcomeFor({ ...base, observedTestOutcome: 'failed' }, 'test')).toBe('failed');
    // The recorded value wins even when the fallback classifier would say otherwise.
    expect(
      testOutcomeFor(
        { ...base, observedTestOutcome: 'passed', outputPreview: ' Tests  1 failed' },
        'test',
      ),
    ).toBe('passed');
  });

  it('falls back to the grader’s classifier when the field is absent', () => {
    // The oldest runs in the corpus omit observedTestOutcome entirely, so this path
    // is live, not hypothetical.
    expect(
      testOutcomeFor(
        { ...base, outputPreview: ' Test Files  3 passed (3)\n Tests  19 passed (19)' },
        'test',
      ),
    ).toBe('passed');
    expect(
      testOutcomeFor(
        { ...base, isError: true, outputPreview: ' Tests  1 failed | 18 passed (19)' },
        'test',
      ),
    ).toBe('failed');
  });

  it('reports no outcome for non-test actions', () => {
    expect(testOutcomeFor({ ...base, toolName: 'read' }, 'explore')).toBeNull();
    expect(testOutcomeFor({ ...base, outputPreview: 'Tests 3 passed' }, 'commit')).toBeNull();
  });
});

/* ------------------------------------------------------------------ batches */

function action(overrides: Partial<ActionRow>): ActionRow {
  return {
    kind: 'action',
    actionIndex: 0,
    decisionIndex: 0,
    seq: 0,
    toolName: 'read',
    phase: 'explore',
    label: 'read a.ts',
    path: 'a.ts',
    detail: null,
    isError: false,
    blockedByHarness: false,
    testOutcome: null,
    batchId: null,
    siblingOrdinal: null,
    inParallelBatch: false,
    outputPreview: '',
    outputBytes: 0,
    event: {} as ActionRow['event'],
    ...overrides,
  };
}

describe('batch grouping', () => {
  it('counts batch members', () => {
    const sizes = batchSizes([
      { batchId: 'turn-1' },
      { batchId: 'turn-1' },
      { batchId: 'turn-2' },
      {},
    ]);
    expect(sizes.get('turn-1')).toBe(2);
    expect(sizes.get('turn-2')).toBe(1);
  });

  it('groups consecutive siblings and marks a real batch as parallel', () => {
    const batches = groupIntoBatches([
      action({ actionIndex: 0, batchId: 'turn-1', siblingOrdinal: 0 }),
      action({ actionIndex: 1, batchId: 'turn-1', siblingOrdinal: 1 }),
      action({ actionIndex: 2, batchId: 'turn-2', siblingOrdinal: 0 }),
    ]);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.isParallel).toBe(true);
    expect(batches[0]?.actions).toHaveLength(2);
    expect(batches[1]?.isParallel).toBe(false);
  });

  it('orders siblings by assistant source order, not settle order', () => {
    const batches = groupIntoBatches([
      action({ actionIndex: 5, batchId: 'turn-1', siblingOrdinal: 2 }),
      action({ actionIndex: 3, batchId: 'turn-1', siblingOrdinal: 0 }),
      action({ actionIndex: 4, batchId: 'turn-1', siblingOrdinal: 1 }),
    ]);
    expect(batches[0]?.actions.map((entry) => entry.siblingOrdinal)).toEqual([0, 1, 2]);
  });

  it('never merges different batches even when adjacent', () => {
    const batches = groupIntoBatches([
      action({ actionIndex: 0, batchId: 'turn-1' }),
      action({ actionIndex: 1, batchId: 'turn-2' }),
      action({ actionIndex: 2, batchId: 'turn-1' }),
    ]);
    expect(batches).toHaveLength(3);
  });

  it('gives each unbatched action its own group', () => {
    const batches = groupIntoBatches([
      action({ actionIndex: 0, batchId: null }),
      action({ actionIndex: 1, batchId: null }),
    ]);
    expect(batches).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------- paths */

describe('path stripping', () => {
  const ws = '/tmp/eaw-run-live-baseline-luna-high-526kGR/workspace';

  it('strips the workspace prefix', () => {
    expect(stripWorkspacePrefix(`${ws}/src/x.ts`, ws)).toBe('src/x.ts');
  });

  it('renders the workspace root itself as "."', () => {
    expect(stripWorkspacePrefix(ws, ws)).toBe('.');
    expect(stripWorkspacePrefix(`${ws}/`, ws)).toBe('.');
  });

  it('leaves already-relative paths untouched', () => {
    // The oldest runs stored relative paths in inputSummary; the bulk store absolute
    // ones. Both shapes reach this function, so both are pinned.
    expect(stripWorkspacePrefix('src/x.ts', ws)).toBe('src/x.ts');
    expect(stripWorkspacePrefix('.', ws)).toBe('.');
  });

  it('does not strip a different workspace, or a path that merely shares a prefix', () => {
    expect(stripWorkspacePrefix('/tmp/other/src/x.ts', ws)).toBe('/tmp/other/src/x.ts');
    expect(stripWorkspacePrefix(`${ws}-2/src/x.ts`, ws)).toBe(`${ws}-2/src/x.ts`);
  });

  it('tolerates a missing workspace path', () => {
    expect(stripWorkspacePrefix('/tmp/x/src/a.ts', null)).toBe('/tmp/x/src/a.ts');
  });

  it('strips every occurrence inside free text such as test output', () => {
    const output = `RUN  v2.1.9 ${ws}\n ✓ ${ws}/tests/a.test.ts (6 tests)`;
    expect(stripWorkspacePrefixEverywhere(output, ws)).toBe(
      'RUN  v2.1.9 .\n ✓ tests/a.test.ts (6 tests)',
    );
  });

  it('escapes regex metacharacters in the workspace path', () => {
    expect(stripWorkspacePrefixEverywhere('/tmp/a+b/w/x.ts', '/tmp/a+b/w')).toBe('x.ts');
  });

  it('splits basename and dirname', () => {
    expect(basename('src/stores/ledger-store.ts')).toBe('ledger-store.ts');
    expect(basename('.')).toBe('.');
    expect(dirname('src/stores/ledger-store.ts')).toBe('src/stores');
    expect(dirname('README.md')).toBe('.');
  });
});

/* --------------------------------------------------------------- band text */

describe('band summaries', () => {
  it('counts tools, most frequent first', () => {
    expect(
      describeComposition([
        action({ toolName: 'read' }),
        action({ toolName: 'read' }),
        action({ toolName: 'ls' }),
      ]),
    ).toBe('2 read, 1 ls');
  });

  it('names a handful of files', () => {
    expect(
      describeTargets([action({ path: 'README.md' }), action({ path: 'package.json' })]),
    ).toBe('README.md, package.json');
  });

  it('collapses many files in one directory', () => {
    const paths = ['a', 'b', 'c', 'd'].map((name) => action({ path: `src/${name}.ts` }));
    expect(describeTargets(paths)).toBe('src/ (4 files)');
  });

  it('reports a bare count when files span directories', () => {
    const paths = ['src/a.ts', 'tests/b.ts', 'docs/c.md', 'x/d.ts'].map((p) =>
      action({ path: p }),
    );
    expect(describeTargets(paths)).toBe('4 files');
  });

  it('is empty when nothing had a path', () => {
    expect(describeTargets([action({ path: null })])).toBe('');
  });
});

/* ------------------------------------------------------ trace compatibility */

describe('trace version normalisation', () => {
  function baseEvent(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      schemaVersion: 1,
      seq: 0,
      decisionIndex: 0,
      logicalActionIndex: 0,
      wallClockIso: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('accepts the supported schema generations', () => {
    for (const version of [1, 2, 3]) {
      const result = normalizeTraceEvent(
        baseEvent({ schemaVersion: version, type: 'trigger_fired', trigger: 't', turnIndex: 0, evidence: {} }),
        TRACE_SCHEMA_VERSION,
      );
      expect(result.ok, `v${version}`).toBe(true);
    }
  });

  it('rejects an unknown schema generation with a reason, not a throw', () => {
    const result = normalizeTraceEvent(
      baseEvent({ schemaVersion: 99, type: 'trigger_fired', trigger: 't', turnIndex: 0, evidence: {} }),
      TRACE_SCHEMA_VERSION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not supported/);
  });

  it('fills a missing ticketDelivery with the documented slack default', () => {
    const result = normalizeTraceEvent(
      baseEvent({
        type: 'run_start',
        runId: 'r',
        scenarioId: 's',
        eventSemantic: 'e',
        delivery: 'd',
        trigger: 't',
        provider: 'p',
        model: 'm',
        thinkingLevel: 'h',
        piPackageVersion: 'v',
        harnessVersion: 'hv',
      }),
      TRACE_SCHEMA_VERSION,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticketDelivery).toBe('slack');
    expect(traceEventSchema.safeParse(result.value.candidate).success).toBe(true);
  });

  it('fills a missing authoritativeContentMessageIds on a v1 decision_boundary', () => {
    const result = normalizeTraceEvent(
      baseEvent({
        type: 'decision_boundary',
        statusBlock: 's',
        statusAnchor: 'a',
        eventBlocks: [],
        contextMessageCount: 1,
        slackUnread: 0,
        slackMentions: 0,
      }),
      TRACE_SCHEMA_VERSION,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceVersion).toBe(1);
    expect(traceEventSchema.safeParse(result.value.candidate).success).toBe(true);
  });

  it('coerces unknown ticket deliveries to slack', () => {
    expect(coerceTicketDelivery('direct')).toBe('direct');
    expect(coerceTicketDelivery('slack')).toBe('slack');
    expect(coerceTicketDelivery(undefined)).toBe('slack');
    expect(coerceTicketDelivery('nonsense')).toBe('slack');
  });

  it('reports a single version per run and flags mixed traces', () => {
    expect(runTraceVersion([2, 2, 2])).toEqual({ version: 2, mixed: false });
    expect(runTraceVersion([1])).toEqual({ version: 1, mixed: false });
    expect(runTraceVersion([1, 2])).toEqual({ version: 1, mixed: true });
    expect(runTraceVersion([])).toEqual({ version: null, mixed: false });
  });
});

/* ------------------------------------------------------------------ metrics */

function bundle(overrides: {
  runId: string;
  scenarioId?: string;
  model?: string;
  valid?: boolean;
  metrics?: Record<string, unknown>;
  ticketDelivery?: 'slack' | 'direct';
  traceSchemaVersion?: 1 | 2 | 3;
}): RunBundle {
  return {
    runId: overrides.runId,
    trace: [],
    reportMd: '',
    diff: '',
    workspacePath: null,
    traceSchemaVersion: overrides.traceSchemaVersion ?? 2,
    ticketDelivery: overrides.ticketDelivery ?? 'slack',
    summary: {
      runId: overrides.runId,
      scenarioId: overrides.scenarioId ?? 'cancel-ambient',
      runtime: { model: overrides.model ?? 'muse-spark-1.3' },
      grade: {
        valid: overrides.valid ?? true,
        classification: 'immediate_inspection_correct_adaptation',
        metrics: overrides.metrics ?? {},
      },
    } as unknown as RunBundle['summary'],
  };
}

describe('metric extraction', () => {
  it('reads the load-time ticketDelivery off the bundle', () => {
    expect(ticketDeliveryOf(bundle({ runId: 'x' }))).toBe('slack');
    expect(ticketDeliveryOf(bundle({ runId: 'x', ticketDelivery: 'direct' }))).toBe('direct');
    expect(DEFAULT_TICKET_DELIVERY).toBe('slack');
  });

  it('formats the indicator-to-content gap', () => {
    expect(
      formatIndicatorToContent({
        indicatorDecision: 11,
        indicatorToContentDecisions: 1,
        indicatorToContentActions: 1,
      } as never),
    ).toBe('1 / 1');
  });

  it('distinguishes "no indicator" from "indicator but never inspected"', () => {
    expect(formatIndicatorToContent({ indicatorDecision: null } as never)).toBe('—');
    expect(
      formatIndicatorToContent({
        indicatorDecision: 7,
        indicatorToContentDecisions: null,
      } as never),
    ).toBe('never');
  });

  it('formats work after content exposure', () => {
    expect(
      formatAfterContent({ mutationsAfterContent: 3, commitsAfterContent: 1 } as never),
    ).toBe('3 · 1');
    expect(
      formatAfterContent({
        mutationsAfterContent: null,
        commitsAfterContent: null,
      } as never),
    ).toBe('—');
  });

  it('treats validity as a hard gate', () => {
    expect(isValid(bundle({ runId: 'a', valid: true }))).toBe(true);
    expect(isValid(bundle({ runId: 'a', valid: false }))).toBe(false);
  });
});

describe('round extraction', () => {
  it('reads an r<n> segment from the run id', () => {
    expect(roundFromRunId('muse-r1-cancel-ambient')).toBe(1);
    expect(roundFromRunId('muse-r12-cancel-ambient')).toBe(12);
    expect(roundFromRunId('cancel-ambient-r3')).toBe(3);
  });

  it('returns null when the id encodes no round', () => {
    expect(roundFromRunId('live-baseline-luna-high')).toBeNull();
    // `refund` starts with r but is not a round segment.
    expect(roundFromRunId('refund-scenario')).toBeNull();
  });
});

describe('grouping runs into index cells', () => {
  it('groups by model, scenario and ticket delivery', () => {
    const cells = groupRuns([
      bundle({ runId: 'm-r1-cancel', scenarioId: 'cancel-ambient' }),
      bundle({ runId: 'm-r2-cancel', scenarioId: 'cancel-ambient' }),
      bundle({ runId: 'm-r1-base', scenarioId: 'baseline' }),
    ]);
    expect(cells).toHaveLength(2);
    const cancel = cells.find((cell) => cell.scenarioId === 'cancel-ambient');
    expect(cancel?.runs.map((entry) => entry.round)).toEqual([1, 2]);
  });

  it('separates the same scenario by ticket delivery', () => {
    const cells = groupRuns([
      bundle({ runId: 'a', ticketDelivery: 'slack' }),
      bundle({ runId: 'b', ticketDelivery: 'direct' }),
    ]);
    expect(cells).toHaveLength(2);
  });

  it('falls back to ordinal rounds when ids encode none', () => {
    const cells = groupRuns([bundle({ runId: 'alpha' }), bundle({ runId: 'beta' })]);
    expect(cells[0]?.runs.map((entry) => entry.round)).toEqual([1, 2]);
  });
});

/* ------------------------------------------------------------- slack channel */

/** A minimal trace builder: only the fields the slack derivation actually reads. */
function slackTrace(events: Array<Record<string, unknown>>): TraceEvent[] {
  return events.map(
    (event, index) =>
      ({
        schemaVersion: TRACE_SCHEMA_VERSION,
        seq: index,
        decisionIndex: 0,
        logicalActionIndex: 0,
        wallClockIso: '2026-01-01T00:00:00.000Z',
        ...event,
      }) as unknown as TraceEvent,
  );
}

function message(
  messageId: string,
  logicalTime: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'slack_message',
    messageId,
    logicalTime,
    channel: 'engineering',
    sender: 'Maya',
    senderRole: 'ticket_owner',
    text: `text of ${messageId}`,
    mentionsAgent: false,
    origin: 'scenario',
    ...overrides,
  };
}

describe('slack channel reconstruction', () => {
  it('keeps arrival order and carries the recorded fields through', () => {
    const thread = slackThreadOf(
      slackTrace([message('m1', -1, { origin: 'initial' }), message('m2', 9)]),
    );
    expect(thread.map((entry) => entry.messageId)).toEqual(['m1', 'm2']);
    expect(thread[0]?.arrivedAtDecision).toBe(-1);
    expect(thread[1]?.arrivedAtDecision).toBe(9);
    expect(thread[1]?.text).toBe('text of m2');
  });

  it('records a read at the decision the read happened, keeping the earliest', () => {
    const thread = slackThreadOf(
      slackTrace([
        message('m1', 0),
        {
          type: 'slack_read',
          decisionIndex: 7,
          actionIndex: 3,
          returnedMessageIds: ['m1'],
          readCursorAfter: 1,
        },
        {
          type: 'slack_read',
          decisionIndex: 12,
          actionIndex: 8,
          returnedMessageIds: ['m1'],
          readCursorAfter: 1,
        },
      ]),
    );
    expect(thread[0]?.readAtDecision).toBe(7);
  });

  it('separates an indicator exposure from a content exposure', () => {
    // The distinction is the experiment: an indicator says an unread exists, and says
    // nothing about what it contains. Collapsing the two would erase the measured gap.
    const thread = slackThreadOf(
      slackTrace([
        message('m2', 9),
        {
          type: 'environment_exposure',
          decisionIndex: 11,
          exposureKind: 'indicator',
          slackMessageId: 'm2',
          exposedText: '<environment_status/>',
        },
        {
          type: 'environment_exposure',
          decisionIndex: 14,
          exposureKind: 'content',
          slackMessageId: 'm2',
          exposedText: 'Stop work on TICKET-14.',
        },
      ]),
    );
    expect(thread[0]?.indicatedAtDecision).toBe(11);
    expect(thread[0]?.exposedAtDecision).toBe(14);
  });

  it('treats a steer exposure as content, because the text does enter context', () => {
    const thread = slackThreadOf(
      slackTrace([
        message('m2', 9),
        {
          type: 'environment_exposure',
          decisionIndex: 10,
          exposureKind: 'steer',
          slackMessageId: 'm2',
          exposedText: 'Stop work.',
        },
      ]),
    );
    expect(thread[0]?.exposedAtDecision).toBe(10);
    expect(thread[0]?.indicatedAtDecision).toBeNull();
  });

  it('marks the injected event and its delivery mechanism', () => {
    const thread = slackThreadOf(
      slackTrace([
        message('m1', -1, { origin: 'initial' }),
        message('m2', 9),
        {
          type: 'environment_delivery',
          decisionIndex: 9,
          scenarioId: 'cancel-ambient',
          eventSemantic: 'cancellation',
          delivery: 'ambient',
          slackMessageId: 'm2',
          mechanism: 'slack_unread',
          intendedDecisionIndex: 10,
          intendedLogicalActionIndex: 20,
        },
      ]),
    );
    expect(environmentEventOf(thread)?.messageId).toBe('m2');
    expect(thread[1]?.deliveryMechanism).toBe('slack_unread');
    expect(thread[0]?.isEnvironmentEvent).toBe(false);
  });

  it('ignores an exposure with no message id rather than throwing', () => {
    const thread = slackThreadOf(
      slackTrace([
        message('m1', 0),
        {
          type: 'environment_exposure',
          decisionIndex: 3,
          exposureKind: 'indicator',
          slackMessageId: null,
          exposedText: '<environment_status/>',
        },
      ]),
    );
    expect(thread[0]?.indicatedAtDecision).toBeNull();
  });
});

describe('slack visibility at a decision', () => {
  const base = {
    messageId: 'm2',
    seq: 10,
    arrivedAtDecision: 9,
    channel: 'engineering',
    sender: 'Priya',
    senderRole: 'ticket_owner',
    text: 'Stop work.',
    mentionsAgent: true,
    origin: 'scenario' as const,
    readAtDecision: null,
    indicatedAtDecision: null,
    exposedAtDecision: null,
    isEnvironmentEvent: true,
    deliveryMechanism: null,
  };

  it('is unsent before it arrives', () => {
    expect(visibilityAt(base, 8)).toBe('unsent');
    expect(visibilityAt(base, 9)).toBe('unread');
  });

  it('reports an indicator without claiming the text was seen', () => {
    const message = { ...base, indicatedAtDecision: 11 };
    expect(visibilityAt(message, 10)).toBe('unread');
    expect(visibilityAt(message, 11)).toBe('indicated');
    expect(isPerceived(visibilityAt(message, 11))).toBe(false);
  });

  it('promotes to read once the agent received it', () => {
    const message = { ...base, indicatedAtDecision: 11, readAtDecision: 14 };
    expect(visibilityAt(message, 13)).toBe('indicated');
    expect(visibilityAt(message, 14)).toBe('read');
    expect(isPerceived(visibilityAt(message, 14))).toBe(true);
  });

  it('ranks an exposure above a read, since the harness placed the text itself', () => {
    const message = { ...base, readAtDecision: 20, exposedAtDecision: 12 };
    expect(visibilityAt(message, 15)).toBe('exposed');
  });

  it('never asks whether the agent read its own post', () => {
    const own = { ...base, origin: 'agent' as const, arrivedAtDecision: 4 };
    expect(visibilityAt(own, 3)).toBe('unsent');
    expect(visibilityAt(own, 4)).toBe('own');
    expect(isPerceived(visibilityAt(own, 4))).toBe(true);
  });
});

/* ------------------------------------------------------------------- turns */

function turnEvent(
  decisionIndex: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'assistant_turn',
    decisionIndex,
    turnIndex: decisionIndex,
    text: '',
    toolCallNames: [],
    stopReason: 'toolUse',
    ...overrides,
  };
}

function actionRow(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    kind: 'action',
    actionIndex: 0,
    decisionIndex: 0,
    seq: 0,
    toolName: 'read',
    phase: 'explore',
    label: 'read a.ts',
    path: 'a.ts',
    detail: null,
    isError: false,
    blockedByHarness: false,
    testOutcome: null,
    batchId: 'turn-0',
    siblingOrdinal: 0,
    inParallelBatch: false,
    outputPreview: '',
    outputBytes: 0,
    event: {} as TraceEvent,
    ...overrides,
  };
}

/**
 * `traceSchemaVersion` is explicit because it is load-bearing for reasoning: the same
 * absent field means "not captured" below v4 and "provider returned none" at or above it.
 * Defaulting it to the local constant would silently reclassify these fixtures the next
 * time the schema moves.
 */
function bundleWith(
  events: Array<Record<string, unknown>>,
  traceSchemaVersion: RunBundle['traceSchemaVersion'] = TRACE_SCHEMA_VERSION as
    RunBundle['traceSchemaVersion'],
): RunBundle {
  return {
    runId: 'r',
    summary: {} as RunBundle['summary'],
    trace: slackTrace(events),
    reportMd: '',
    diff: '',
    workspacePath: null,
    traceSchemaVersion,
    ticketDelivery: 'slack',
  };
}

describe('turn rows', () => {
  it('attaches actions to the turn recorded at the same decision', () => {
    const run = bundleWith([turnEvent(0), turnEvent(1)]);
    const rows = turnRowsOf(run, [
      actionRow({ actionIndex: 0, decisionIndex: 0 }),
      actionRow({ actionIndex: 1, decisionIndex: 1, label: 'read b.ts', path: 'b.ts' }),
      actionRow({ actionIndex: 2, decisionIndex: 1, label: 'read c.ts', path: 'c.ts' }),
    ]);
    expect(rows.map((row) => row.actions.length)).toEqual([1, 2]);
  });

  it('groups by decision rather than by batch id', () => {
    // decisionIndex is the only clock the harness guarantees; batchId is a convenience.
    const run = bundleWith([turnEvent(0)]);
    const rows = turnRowsOf(run, [
      actionRow({ actionIndex: 0, decisionIndex: 0, batchId: null }),
      actionRow({ actionIndex: 1, decisionIndex: 0, batchId: 'something-else' }),
    ]);
    expect(rows[0]?.actions).toHaveLength(2);
  });

  it('orders siblings by assistant source order, not settle order', () => {
    const run = bundleWith([turnEvent(0)]);
    const rows = turnRowsOf(run, [
      actionRow({ actionIndex: 5, decisionIndex: 0, siblingOrdinal: 2, label: 'third' }),
      actionRow({ actionIndex: 3, decisionIndex: 0, siblingOrdinal: 0, label: 'first' }),
      actionRow({ actionIndex: 4, decisionIndex: 0, siblingOrdinal: 1, label: 'second' }),
    ]);
    expect(rows[0]?.actions.map((action) => action.label)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('names a single call by its own label and a batch by its census', () => {
    const run = bundleWith([turnEvent(0), turnEvent(1)]);
    const rows = turnRowsOf(run, [
      actionRow({ actionIndex: 0, decisionIndex: 0, label: 'edit ledger-store.ts' }),
      actionRow({ actionIndex: 1, decisionIndex: 1, toolName: 'read' }),
      actionRow({ actionIndex: 2, decisionIndex: 1, toolName: 'ls', phase: 'explore' }),
    ]);
    expect(rows[0]?.headline).toBe('edit ledger-store.ts');
    expect(rows[1]?.headline).toBe('2 calls · 1 ls, 1 read');
  });

  it('reports narration only when the trace recorded some', () => {
    const run = bundleWith([
      turnEvent(0),
      turnEvent(1, { text: '  ', stopReason: 'toolUse' }),
      turnEvent(2, { text: 'Done. Left the tree as-is.', stopReason: 'stop' }),
    ]);
    const rows = turnRowsOf(run, []);
    expect(rows.map((row) => row.hasNarration)).toEqual([false, false, true]);
    expect(rows[2]?.isFinal).toBe(true);
  });

  it('takes the dominant phase of a mixed batch', () => {
    const run = bundleWith([turnEvent(0)]);
    const rows = turnRowsOf(run, [
      actionRow({ actionIndex: 0, decisionIndex: 0, phase: 'explore' }),
      actionRow({ actionIndex: 1, decisionIndex: 0, phase: 'modify' }),
      actionRow({ actionIndex: 2, decisionIndex: 0, phase: 'modify' }),
    ]);
    expect(rows[0]?.phase).toBe('modify');
  });

  it('finds the final report as the last turn carrying text', () => {
    const run = bundleWith([
      turnEvent(0, { text: 'thinking out loud' }),
      turnEvent(1),
      turnEvent(2, { text: 'final answer', stopReason: 'stop' }),
    ]);
    expect(finalReportOf(turnRowsOf(run, []))).toBe('final answer');
  });

  it('returns an empty report rather than a placeholder when nothing was recorded', () => {
    expect(finalReportOf(turnRowsOf(bundleWith([turnEvent(0)]), []))).toBe('');
  });
});

describe('decision range', () => {
  it('spans every decision the model was called at', () => {
    const run = bundleWith([turnEvent(0), turnEvent(1), turnEvent(2)]);
    expect(decisionRangeOf(run.trace)).toEqual({ min: 0, max: 2 });
  });

  it('falls back to a single point for a trace with no model calls', () => {
    expect(decisionRangeOf([])).toEqual({ min: 0, max: 0 });
  });
});

describe('reasoning capture', () => {
  const v4 = (overrides: Record<string, unknown>): RunBundle =>
    bundleWith([turnEvent(0, overrides)], 4);
  const legacy = (overrides: Record<string, unknown> = {}): RunBundle =>
    bundleWith([turnEvent(0, overrides)], 3);

  it('shows reasoning when a v4 trace recorded some', () => {
    const rows = turnRowsOf(v4({ reasoningText: 'The channel has an unread mention.' }), []);
    expect(rows[0]?.reasoningState).toBe('present');
    expect(rows[0]?.reasoning).toBe('The channel has an unread mention.');
  });

  it('distinguishes a provider that returned nothing from a harness that never asked', () => {
    // This is the whole reason the schema version moved: the same absent field means
    // different things either side of v4, and the reader must not have to guess which.
    expect(turnRowsOf(v4({}), [])[0]?.reasoningState).toBe('none_returned');
    expect(turnRowsOf(legacy(), [])[0]?.reasoningState).toBe('not_captured');
  });

  it('reports a redacted block as redacted, not as absent', () => {
    const rows = turnRowsOf(v4({ reasoningText: '', reasoningRedacted: true }), []);
    expect(rows[0]?.reasoningState).toBe('redacted');
    expect(rows[0]?.reasoning).toBeNull();
  });

  it('keeps the token count even when the text was withheld', () => {
    const rows = turnRowsOf(v4({ reasoningTokens: 512 }), []);
    expect(rows[0]?.reasoningState).toBe('none_returned');
    expect(rows[0]?.reasoningTokens).toBe(512);
  });

  it('never reports reasoning as captured for a pre-v4 trace, whatever the fields say', () => {
    expect(reasoningStateOf({ reasoningText: 'x' }, false)).toBe('not_captured');
    expect(
      turnRowsOf(legacy({ reasoningText: 'leaked from somewhere' }), [])[0]?.reasoning,
    ).toBeNull();
  });

  it('treats whitespace-only reasoning as nothing returned', () => {
    expect(turnRowsOf(v4({ reasoningText: '   \n ' }), [])[0]?.reasoningState).toBe(
      'none_returned',
    );
  });
});
