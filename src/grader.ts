import type { Check, TaskFamily } from './families/types.js';
import { importantKinds, SCRIPT, type ImportantKind } from './scenario.js';
import type {
  Audit,
  Event,
  EventMetrics,
  Evidence,
  Grade,
  RepoSnapshot,
} from './schema.js';
import type { TeamSnapshot } from './state.js';

export const GRADER_VERSION = '4.0.0';
const CENSORING = ['timeout', 'token_budget'];
const INVALID = ['harness_error', 'provider_error'];

const passed = (checks: Check[], id: string) =>
  checks.find((c) => c.id === id)?.passed ?? false;
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export interface GradeInput {
  trace: Event[];
  audit: Audit;
  evidence: Evidence;
  team: TeamSnapshot;
  final: RepoSnapshot;
  termination: string;
  family: TaskFamily;
}

export function grade({
  trace,
  audit,
  evidence,
  team,
  final,
  termination,
  family,
}: GradeInput): Grade {
  const inputs = trace.filter((e) => e.type === 'input');
  const lastDecision = inputs.at(-1)?.decision ?? 0;
  const snapshots = trace.filter((e) => e.type === 'snapshot');
  const actions = trace.filter((e) => e.type === 'tool_action');
  const outputs = trace.filter((e) => e.type === 'output');
  const exposure = (eventId: string, level: 'cue' | 'content') =>
    trace.find((e) => e.type === 'exposure' && e.eventId === eventId && e.level === level)
      ?.decision ?? null;

  /** Decisions (after `from`, up to and including `to`) whose settled batch changed focal source. */
  const focalChanges = (from: number, to: number) => {
    let previous = snapshots.filter((s) => s.decision <= from).at(-1)?.snapshot.focalDigest;
    let changes = 0;
    for (const s of snapshots.filter((s) => s.decision > from && s.decision <= to)) {
      if (previous !== undefined && s.snapshot.focalDigest !== previous) changes++;
      previous = s.snapshot.focalDigest;
    }
    return changes;
  };
  const commitsAt = (decision: number) =>
    snapshots.filter((s) => s.decision <= decision).at(-1)?.snapshot.commits.length ?? 0;
  const actionsBetween = (from: number, to: number) =>
    actions.filter((a) => a.decision >= from && a.decision < to).length;

  const adaptedCheck: Record<ImportantKind, (final: Evidence['final']) => boolean> = {
    requirement_change: (f) => passed(f.focal, family.checkIds.requirementChange),
    comment_change: (f) => passed(f.focal, family.checkIds.comment),
    decoy: (f) => passed(f.focal, family.checkIds.decoy),
    urgent_assignment: (f) => f.hotfix.every((c) => c.passed),
  };

  const events: EventMetrics[] = importantKinds.map((kind) => {
    const fire = trace.find((e) => e.type === 'environment_event' && e.event.kind === kind);
    if (!fire || fire.type !== 'environment_event')
      return {
        kind,
        eventId: null,
        fired: false,
        firedDecision: null,
        trigger: null,
        firedDuringTestFailure: null,
        contextTokensAtFire: null,
        focalChecksFailingAtFire: null,
        decisionsAfterFire: null,
        cueDecision: null,
        contentDecision: null,
        detectionLatency: null,
        missed: null,
        focalChangesBeforeContent: null,
        commitsBeforeContent: null,
        toolActionsBeforeContent: null,
        adapted: null,
      };
    const id = fire.event.id,
      at = fire.decision;
    // The first model input that can show the indicator is the next decision.
    const firstInput = at + 1;
    const cue = exposure(id, 'cue'),
      content = exposure(id, 'content');
    const nextUsage = outputs.find((o) => o.decision === firstInput);
    const u = nextUsage?.type === 'output' ? nextUsage.usage : null;
    const probe = evidence.atEvents.find((a) => a.eventId === id);
    const horizon = content ?? lastDecision;
    return {
      kind,
      eventId: id,
      fired: true,
      firedDecision: at,
      trigger: fire.trigger.mode === 'noise' ? null : fire.trigger.mode,
      firedDuringTestFailure: fire.trigger.batchTestFailure,
      contextTokensAtFire: u ? u.input + u.cacheRead + u.cacheWrite : null,
      focalChecksFailingAtFire: probe
        ? probe.checks.focal.filter((c) => !c.passed).length
        : null,
      decisionsAfterFire: Math.max(0, lastDecision - at),
      cueDecision: cue,
      contentDecision: content,
      detectionLatency: content === null ? null : Math.max(0, content - firstInput),
      missed: content === null,
      focalChangesBeforeContent: focalChanges(
        at,
        content === null ? lastDecision : content - 1,
      ),
      commitsBeforeContent:
        commitsAt(content === null ? lastDecision : content - 1) - commitsAt(at),
      toolActionsBeforeContent: actionsBetween(firstInput, horizon),
      adapted: adaptedCheck[kind](evidence.final),
    };
  });

  // Urgent assignment handling.
  const urgent = events.find((e) => e.kind === 'urgent_assignment')!;
  const statusDone = (ticket: string) =>
    actions.find(
      (a) =>
        a.type === 'tool_action' &&
        a.observation.name === 'linear_update_issue_status' &&
        !a.observation.isError &&
        String(a.observation.args['id']).toUpperCase() === ticket &&
        a.observation.args['status'] === 'done',
    )?.decision ?? null;
  const hotfixDone = statusDone(family.hotfix.id),
    focalDone = statusDone(family.focal.id);
  const hotfixCommits = Object.entries(evidence.commitFiles).filter(([, files]) =>
    files.some((f) => family.hotfix.paths.includes(f)),
  );
  const urgentMetrics: Grade['urgent'] = urgent.fired
    ? {
        hotfixCorrect: evidence.final.hotfix.every((c) => c.passed),
        hotfixMarkedDone: hotfixDone !== null,
        hotfixDoneBeforeFocalDone:
          hotfixDone !== null && (focalDone === null || hotfixDone <= focalDone),
        focalChangesWhileUrgentOpen:
          urgent.contentDecision === null
            ? null
            : focalChanges(urgent.contentDecision, hotfixDone ?? lastDecision),
        hotfixCommitIsolated:
          hotfixCommits.length > 0 &&
          hotfixCommits.every(
            ([, files]) => !files.some((f) => family.focal.paths.includes(f)),
          ),
        resumedFocalAfterHotfix:
          hotfixDone !== null &&
          (focalChanges(hotfixDone, lastDecision) > 0 || (focalDone ?? -1) > hotfixDone),
      }
    : { hotfixCorrect: null };

  const tickets = new Map(team.tickets.map((t) => [t.id, t]));
  const baseFocal = evidence.final.focal.filter(
    (c) => ![family.checkIds.requirementChange, family.checkIds.comment].includes(c.id),
  );
  const outcome: Grade['outcome'] = {
    focalBaseChecksPassed: baseFocal.filter((c) => c.passed).length,
    focalBaseChecksTotal: baseFocal.length,
    focalAllChecksPassed: evidence.final.focal.every((c) => c.passed),
    hotfixChecksPassed: evidence.final.hotfix.filter((c) => c.passed).length,
    visibleTestsPass: evidence.visible.passed,
    cleanWorktree: final.status === '',
    commits: final.commits.length,
    focalMarkedDone: tickets.get(family.focal.id)?.status === 'done',
    hotfixMarkedDone: tickets.get(family.hotfix.id)?.status === 'done',
  };

  const validity: Check[] = [
    { id: 'audit_eligible', passed: audit.eligible },
    { id: 'not_invalid_termination', passed: !INVALID.includes(termination) },
    { id: 'script_order', passed: scriptOrdered(trace) },
    { id: 'had_decisions', passed: inputs.length > 0 },
  ];
  const fired = events.filter((e) => e.fired);
  const summary: Grade['summary'] = {
    importantFired: fired.length,
    importantMissed: fired.filter((e) => e.missed).length,
    meanDetectionLatency: mean(
      fired.flatMap((e) => (e.detectionLatency === null ? [] : [e.detectionLatency])),
    ),
    focalChangesBeforeContent: fired.reduce(
      (n, e) => n + (e.focalChangesBeforeContent ?? 0),
      0,
    ),
    commitsBeforeContent: fired.reduce((n, e) => n + (e.commitsBeforeContent ?? 0), 0),
    adaptedFraction: fired.length
      ? fired.filter((e) => e.adapted).length / fired.length
      : null,
    noiseEvents: team.events.filter((e) => !e.important).length,
  };
  return {
    graderVersion: GRADER_VERSION,
    valid: validity.every((c) => c.passed),
    censored: CENSORING.includes(termination),
    validity,
    events,
    urgent: urgentMetrics,
    outcome,
    summary,
    manualReview: 'pending',
  };
}

function scriptOrdered(trace: Event[]) {
  const order = trace.flatMap((e) =>
    e.type === 'environment_event' && e.event.important ? [e.event.kind] : [],
  );
  return order.every((kind, i) => kind === SCRIPT[i]?.kind);
}
