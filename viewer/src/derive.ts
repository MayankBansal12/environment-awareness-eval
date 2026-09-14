import type { Comparison } from '../../src/experiment.js';
import type { ToolObservation } from '../../src/harness/repo-tools.js';
import { importantKinds, TEST_COMMAND, type ImportantKind } from '../../src/scenario.js';
import type { Event } from '../../src/schema.js';
import type { RunDetail, RunRow } from './model.js';

export const LOADS = ['low', 'medium', 'high'] as const;
export const KIND_LABEL: Record<ImportantKind, string> = {
  requirement_change: 'Requirement change',
  urgent_assignment: 'Urgent hotfix',
  comment_change: 'Buried comment',
  decoy: 'Decoy opinion',
};

export interface UpdateMark {
  eventId: string;
  kind: ImportantKind | 'noise';
  text: string;
  trigger: 'condition' | 'fallback' | 'noise';
  duringTestFailure: boolean;
}

export interface DecisionRow {
  decision: number;
  unread: { linear: number; slack: number };
  stopReason: string;
  tokens: number;
  costUsd: number;
  cumulativeTokens: number;
  cumulativeCostUsd: number;
  actions: ToolObservation[];
  focalEdit: boolean;
  hotfixEdit: boolean;
  commits: number;
  testFailure: boolean;
  fired: UpdateMark[];
  exposures: Array<{
    eventId: string;
    kind: ImportantKind;
    level: 'cue' | 'content';
    via: string;
  }>;
  retries: number;
  compaction: boolean;
  errorMessage?: string;
}

export const isTestFailure = (o: ToolObservation) =>
  o.name === 'bash' &&
  TEST_COMMAND.test(String(o.args['command'] ?? '')) &&
  (o.isError || (o.value as { exitCode?: number } | null)?.exitCode !== 0);

/** One row per model decision. Environment events fired at a boundary belong to that decision. */
export function decisionRows(trace: Event[]): DecisionRow[] {
  const kinds = new Map<string, ImportantKind | 'noise'>();
  const rows: DecisionRow[] = [];
  let focal: string | undefined, hotfix: string | undefined, commits: number | undefined;
  let tokens = 0,
    cost = 0;
  for (const e of trace) {
    if (e.type === 'snapshot' && e.decision === 0) {
      focal = e.snapshot.focalDigest;
      hotfix = e.snapshot.hotfixDigest;
      commits = e.snapshot.commits.length;
    }
    if (e.decision < 1) continue;
    const row = (rows[e.decision - 1] ??= {
      decision: e.decision,
      unread: { linear: 0, slack: 0 },
      stopReason: '',
      tokens: 0,
      costUsd: 0,
      cumulativeTokens: tokens,
      cumulativeCostUsd: cost,
      actions: [],
      focalEdit: false,
      hotfixEdit: false,
      commits: 0,
      testFailure: false,
      fired: [],
      exposures: [],
      retries: 0,
      compaction: false,
    });
    if (e.type === 'input') row.unread = e.counts;
    else if (e.type === 'output') {
      row.stopReason = e.stopReason;
      row.tokens = e.usage?.totalTokens ?? 0;
      row.costUsd = e.usage?.costUsd ?? 0;
      tokens += row.tokens;
      cost += row.costUsd;
      row.cumulativeTokens = tokens;
      row.cumulativeCostUsd = cost;
      if (e.errorMessage) row.errorMessage = e.errorMessage;
    } else if (e.type === 'tool_action') {
      row.actions.push(e.observation);
      if (isTestFailure(e.observation)) row.testFailure = true;
    } else if (e.type === 'snapshot') {
      const s = e.snapshot;
      if (focal !== undefined && s.focalDigest !== focal) row.focalEdit = true;
      if (hotfix !== undefined && s.hotfixDigest !== hotfix) row.hotfixEdit = true;
      row.commits += Math.max(0, s.commits.length - (commits ?? s.commits.length));
      focal = s.focalDigest;
      hotfix = s.hotfixDigest;
      commits = s.commits.length;
    } else if (e.type === 'environment_event') {
      kinds.set(e.event.id, e.event.kind);
      row.fired.push({
        eventId: e.event.id,
        kind: e.event.kind,
        text: e.event.text,
        trigger: e.trigger.mode,
        duringTestFailure: e.trigger.batchTestFailure,
      });
    } else if (e.type === 'exposure') {
      const kind = kinds.get(e.eventId);
      if (kind && kind !== 'noise')
        row.exposures.push({ eventId: e.eventId, kind, level: e.level, via: e.via });
    } else if (e.type === 'provider_retry') row.retries++;
    else if (e.type === 'compaction') row.compaction = true;
  }
  return rows;
}

export interface RunFilters {
  experiment: string;
  family: string;
  load: string;
  noise: string;
  delivery: string;
}
export const NO_FILTERS: RunFilters = {
  experiment: '',
  family: '',
  load: '',
  noise: '',
  delivery: '',
};

export function filterRuns(rows: RunRow[], f: RunFilters): RunRow[] {
  return rows.filter(
    (r) =>
      (!f.experiment || (r.experiment ?? 'dev') === f.experiment) &&
      (!f.family || r.condition.family === f.family) &&
      (!f.load || r.condition.load === f.load) &&
      (!f.noise || r.condition.noise === f.noise) &&
      (!f.delivery || r.condition.delivery === f.delivery),
  );
}

export type Cell = Comparison['cells'][number];
export interface TrendGroup {
  /** `family/noise/delivery` */
  key: string;
  byLoad: Partial<Record<(typeof LOADS)[number], Cell>>;
}

/** Cells grouped so that load is the only thing varying within a group, ordered low → high. */
export function trendGroups(comparison: Comparison): TrendGroup[] {
  const groups = new Map<string, TrendGroup>();
  for (const cell of comparison.cells) {
    const [family, load, noise, delivery] = cell.cell.split('/') as [
      string,
      string,
      string,
      string,
    ];
    const key = `${family}/${noise}/${delivery}`;
    const group = groups.get(key) ?? { key, byLoad: {} };
    group.byLoad[load as (typeof LOADS)[number]] = cell;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export { importantKinds };
/** Comparison cells always carry every important kind. */
export const cellEvent = (cell: Cell, kind: ImportantKind) => cell.events[kind]!;

/** Captured input messages for a decision, flagging those not present in the previous input. */
export function inputMessages(run: RunDetail, decision: number) {
  const previous = new Set(run.inputs[decision - 1] ?? []);
  return (run.inputs[decision] ?? []).map((i) => ({
    message: run.messages[i]!,
    isNew: !previous.has(i),
  }));
}
