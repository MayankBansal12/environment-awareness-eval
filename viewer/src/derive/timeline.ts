/**
 * The run timeline: actions, phase bands, and the markers that carry the result.
 *
 * Ordering is by `seq`, the trace's own logical clock. Markers are placed by `seq` too, so
 * an exposure lands exactly between the action before it and the action after it — the
 * vertical distance between the indicator and content bands is the headline metric and it
 * has to be literally true, not approximated.
 */

import type { TraceEvent } from '../../../src/trace/schema.js';
import { batchSizes } from './batches.js';
import type {
  ActionRow,
  MarkerRow,
  PhaseBand,
  PhaseKind,
  RunBundle,
  TimelineRow,
  WorkspaceState,
} from './model.js';
import { basename, dirname } from './paths.js';
import { toActionRow } from './phases.js';

export function workspacePathOf(trace: readonly TraceEvent[]): string | null {
  for (const event of trace) {
    if (event.type === 'fixture_prepared') return event.workspacePath;
  }
  return null;
}

export function actionRowsOf(run: RunBundle): ActionRow[] {
  const actions = run.trace.filter(
    (event): event is Extract<TraceEvent, { type: 'tool_action' }> =>
      event.type === 'tool_action',
  );
  const sizes = batchSizes(actions);
  return actions
    .map((action) => toActionRow(action, run.workspacePath, sizes))
    .sort((a, b) => a.seq - b.seq);
}

/** The markers that structure a run: trigger, exposures, termination. */
export function markerRowsOf(trace: readonly TraceEvent[]): MarkerRow[] {
  const rows: MarkerRow[] = [];
  for (const event of trace) {
    switch (event.type) {
      case 'trigger_fired':
        rows.push({
          kind: 'marker',
          marker: 'trigger',
          decisionIndex: event.decisionIndex,
          seq: event.seq,
          title: `TRIGGER ${event.trigger}`,
          detail: '',
          event,
        });
        break;
      case 'environment_exposure': {
        const marker =
          event.exposureKind === 'indicator'
            ? 'indicator'
            : event.exposureKind === 'steer'
              ? 'steer'
              : 'content';
        rows.push({
          kind: 'marker',
          marker,
          decisionIndex: event.decisionIndex,
          seq: event.seq,
          title:
            marker === 'indicator'
              ? 'INDICATOR EXPOSED'
              : marker === 'steer'
                ? 'STEERED CONTENT'
                : 'CONTENT EXPOSED',
          detail: event.exposedText,
          event,
        });
        break;
      }
      case 'termination':
        rows.push({
          kind: 'marker',
          marker: 'termination',
          decisionIndex: event.decisionIndex,
          seq: event.seq,
          title: `TERMINATED · ${event.reason}`,
          detail: event.detail,
          event,
        });
        break;
      default:
        break;
    }
  }
  return rows;
}

/**
 * Collapses consecutive same-phase actions into a band. Bands never span a marker: an
 * exposure or trigger always breaks the run, because work before and after an exposure
 * means completely different things.
 */
export function buildDigest(
  actions: readonly ActionRow[],
  markers: readonly MarkerRow[],
): TimelineRow[] {
  const merged: (ActionRow | MarkerRow)[] = [...actions, ...markers].sort(
    (a, b) => a.seq - b.seq,
  );

  const rows: TimelineRow[] = [];
  let pending: ActionRow[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    rows.push(pending.length === 1 ? pending[0]! : toBand(pending));
    pending = [];
  };

  for (const row of merged) {
    if (row.kind === 'marker') {
      flush();
      rows.push(row);
      continue;
    }
    const head = pending[0];
    if (head !== undefined && head.phase !== row.phase) flush();
    pending.push(row);
  }
  flush();
  return rows;
}

function toBand(actions: ActionRow[]): PhaseBand {
  const first = actions[0]!;
  const decisions = actions.map((action) => action.decisionIndex);
  return {
    kind: 'band',
    phase: first.phase,
    fromDecision: Math.min(...decisions),
    toDecision: Math.max(...decisions),
    actions,
    composition: describeComposition(actions),
    targets: describeTargets(actions),
  };
}

/** e.g. `3 ls, 2 read` — counts by tool, most frequent first. */
export function describeComposition(actions: readonly ActionRow[]): string {
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.toolName, (counts.get(action.toolName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool, count]) => `${count} ${tool}`)
    .join(', ');
}

/**
 * e.g. `README, package.json` for a couple of files, or `src/ (7 files)` once a band
 * touches enough of one tree that naming them all stops being scannable.
 */
export function describeTargets(actions: readonly ActionRow[]): string {
  const paths = [
    ...new Set(
      actions
        .map((action) => action.path)
        .filter((path): path is string => path !== null && path !== ''),
    ),
  ];
  if (paths.length === 0) return '';
  if (paths.length <= 3) return paths.map(basename).join(', ');

  const dirs = new Set(paths.map(dirname));
  if (dirs.size === 1) {
    const dir = [...dirs][0]!;
    const prefix = dir === '.' ? '' : `${dir}/`;
    return `${prefix === '' ? 'root' : prefix} (${paths.length} files)`;
  }
  return `${paths.length} files`;
}

/**
 * Workspace state as of a decision: the nearest snapshot at or before it. Snapshots are
 * taken once per settled turn, so a decision always has one behind it after the first.
 */
export function workspaceStateByDecision(
  trace: readonly TraceEvent[],
): Map<number, WorkspaceState> {
  const states = new Map<number, WorkspaceState>();
  for (const event of trace) {
    if (event.type !== 'workspace_snapshot') continue;
    states.set(event.decisionIndex, {
      sourceMutated: event.sourceMutated,
      workingTreeDirty: event.workingTreeDirty,
      commitsAheadOfFixture: event.commitsAheadOfFixture,
    });
  }
  return states;
}

/** Carries the last known state forward for decisions with no snapshot of their own. */
export function stateAt(
  states: Map<number, WorkspaceState>,
  decisionIndex: number,
): WorkspaceState | null {
  for (let index = decisionIndex; index >= 0; index -= 1) {
    const state = states.get(index);
    if (state !== undefined) return state;
  }
  return null;
}

export type { PhaseKind };
