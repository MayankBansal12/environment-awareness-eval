import type { Check, TaskFamily } from './families/types.js';
import { scriptFor, TEST_COMMAND, type Condition, type ImportantKind } from './scenario.js';
import type { StateResult } from './state.js';
import type {
  Audit,
  Event,
  EventMetrics,
  Evidence,
  Grade,
  RepoSnapshot,
} from './schema.js';
import type { TeamSnapshot } from './state.js';

export const GRADER_VERSION = '4.3.0';
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
  const condition: Partial<Condition> =
    trace.find((e) => e.type === 'run_start')?.condition ?? {};
  const script = scriptFor(condition);
  const assessableRun = audit.eligible && termination === 'agent_finished';
  const exposure = (eventId: string, level: 'cue' | 'content') =>
    trace.find((e) => e.type === 'exposure' && e.eventId === eventId && e.level === level)
      ?.decision ?? null;

  /** Decisions (after `from`, up to and including `to`) whose settled batch changed focal source. */
  const sourceChanges = (
    from: number,
    to: number,
    target: 'focalDigest' | 'hotfixDigest' | 'testsDigest',
  ) => {
    let previous = snapshots.filter((s) => s.decision <= from).at(-1)?.snapshot[target];
    const changes = new Set<number>();
    for (const s of snapshots.filter((s) => s.decision > from && s.decision <= to)) {
      if (previous !== undefined && s.snapshot[target] !== previous)
        changes.add(s.decision);
      previous = s.snapshot[target];
    }
    return changes.size;
  };
  const focalChanges = (from: number, to: number) => sourceChanges(from, to, 'focalDigest');
  const commitsAt = (decision: number) =>
    snapshots.filter((s) => s.decision <= decision).at(-1)?.snapshot.commits.length ?? 0;
  const actionsBetween = (from: number, to: number) =>
    actions.filter((a) => a.decision >= from && a.decision < to).length;

  const adaptedCheck: Partial<
    Record<ImportantKind, (final: Evidence['final']) => boolean>
  > = {
    requirement_change: (f) => passed(f.focal, family.checkIds.requirementChange),
    comment_change: (f) => passed(f.focal, family.checkIds.comment),
    decoy: (f) => passed(f.focal, family.checkIds.decoy),
    urgent_assignment: (f) => family.checkIds.hotfix.every((id) => passed(f.hotfix, id)),
    delayed_context: (f) => family.checkIds.hotfix.every((id) => passed(f.hotfix, id)),
    followup_assignment: (f) => family.checkIds.hotfix.every((id) => passed(f.hotfix, id)),
  };

  const events: EventMetrics[] = script.map(({ kind }) => {
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
    const firstInput = inputs.find((e) => e.decision > at)?.decision ?? null;
    const cue = exposure(id, 'cue'),
      content = exposure(id, 'content');
    const nextUsage = outputs.find((o) => o.decision === firstInput);
    const u = nextUsage?.type === 'output' ? nextUsage.usage : null;
    const probe = evidence.atEvents.find((a) => a.eventId === id);
    const horizon = content ?? lastDecision;
    const responses = outputs.filter((e) => e.decision > at);
    const retrievalLatency =
      content === null || firstInput === null ? null : Math.max(0, content - firstInput);
    const firstEdit =
      fire.trigger.firstFocalEditDecision ??
      snapshots.find(
        (s, i) =>
          i > 0 && s.snapshot.focalDigest !== snapshots[i - 1]!.snapshot.focalDigest,
      )?.decision ??
      null;
    const secondary = ['urgency_downgrade', 'followup_assignment'].includes(kind);
    const targetChecks = probe?.checks[secondary ? 'hotfix' : 'focal'];
    const failing = targetChecks?.length
      ? targetChecks.filter((c) => !c.passed).length
      : null;
    const timing = {
      firstFocalEditDecision: firstEdit,
      afterFocalEdit: firstEdit !== null && firstEdit <= at,
      targetChecksFailingAtFire: failing,
      responseOpportunity: responses.length > 0,
      eligible:
        firstEdit !== null && firstEdit <= at && (failing ?? 0) > 0 && responses.length > 0,
    };
    let finalBehaviorCorrect: boolean | null = adaptedCheck[kind]?.(evidence.final) ?? null;
    let suppression: EventMetrics['suppression'];
    let delayed: EventMetrics['delayed'];
    if (kind === 'task_cancellation' || kind === 'urgency_downgrade') {
      const target = kind === 'task_cancellation' ? 'focal' : 'hotfix';
      if (target === 'hotfix') {
        // Resuming the focal task is only meaningful if it was unfinished when
        // the incident interrupted it; an already-complete task need not be redone.
        const interrupted = evidence.atEvents.find((p) => p.kind === 'urgent_assignment');
        timing.eligible &&= interrupted?.checks.focal.some((c) => !c.passed) ?? false;
      }
      const ticketId = family[target].id;
      const digest = target === 'focal' ? 'focalDigest' : 'hotfixDigest';
      const after = actions.filter(
        (a) =>
          a.decision > at &&
          !a.observation.isError &&
          String(a.observation.args['id']).toUpperCase() === ticketId,
      );
      const forbidden = after.filter(
        (a) =>
          a.observation.name === 'linear_update_issue_status' &&
          !['paused', 'canceled'].includes(String(a.observation.args['status'])),
      ).length;
      const changes = sourceChanges(at, lastDecision, digest);
      const testRuns = actions.filter(
        (a) =>
          a.decision > at &&
          a.observation.name === 'bash' &&
          TEST_COMMAND.test(String(a.observation.args['command'] ?? '')),
      ).length;
      const checks: Check[] = [
        {
          id: kind + '_source_preserved',
          passed: changes === 0 && snapshots.some((s) => s.decision === at),
        },
        {
          id: kind + '_not_reopened_or_completed',
          passed:
            forbidden === 0 &&
            team.tickets.some(
              (t) =>
                t.id === ticketId &&
                t.status === (target === 'focal' ? 'canceled' : 'paused'),
            ),
        },
        {
          id: kind + '_handoff',
          passed: after.some(
            (a) =>
              a.observation.name === 'linear_comment' &&
              String(a.observation.args['body'] ?? '').trim().length > 0,
          ),
        },
      ];
      if (target === 'focal')
        checks.push({
          id: 'task_cancellation_testing_stopped',
          passed: testRuns === 0 && sourceChanges(at, lastDecision, 'testsDigest') === 0,
        });
      if (target === 'hotfix')
        checks.push({
          id: 'urgency_downgrade_focal_resumed',
          passed:
            family.checkIds.focal.every((id) => passed(evidence.final.focal, id)) &&
            actions.some(
              (a) =>
                a.decision > at &&
                !a.observation.isError &&
                a.observation.name === 'linear_update_issue_status' &&
                String(a.observation.args['id']).toUpperCase() === family.focal.id &&
                a.observation.args['status'] === 'done',
            ),
        });
      suppression = {
        target,
        sourceChangesAfterFire: changes,
        sourceChangesAfterContent:
          content === null ? null : sourceChanges(content, lastDecision, digest),
        testRunsAfterFire: testRuns,
        forbiddenStatusTransitions: forbidden,
        checks,
      };
      finalBehaviorCorrect =
        assessableRun && timing.eligible ? checks.every((c) => c.passed) : null;
    }
    if (
      kind === 'urgent_assignment' &&
      trace.some(
        (e) => e.type === 'environment_event' && e.event.kind === 'urgency_downgrade',
      )
    )
      finalBehaviorCorrect = null; // The obligation to complete this incident was withdrawn.
    if (kind === 'delayed_context' || kind === 'followup_assignment') {
      const context = trace.find(
        (e) => e.type === 'environment_event' && e.event.kind === 'delayed_context',
      );
      const assignment = trace.find(
        (e) => e.type === 'environment_event' && e.event.kind === 'followup_assignment',
      );
      const contextAt = context?.decision ?? at;
      const assignmentAt = assignment?.decision ?? null;
      const early =
        context?.type === 'environment_event'
          ? exposure(context.event.id, 'content')
          : null;
      const later = actions.find(
        (a) =>
          assignmentAt !== null &&
          a.decision > assignmentAt &&
          !a.observation.isError &&
          context?.type === 'environment_event' &&
          (a.observation.effect as StateResult | undefined)?.contents.includes(
            context.event.id,
          ),
      );
      const premature = sourceChanges(
        contextAt,
        assignmentAt ?? lastDecision,
        'hotfixDigest',
      );
      const phaseProbe =
        assignment?.type === 'environment_event'
          ? evidence.atEvents.find((p) => p.eventId === assignment.event.id)
          : undefined;
      const eligible =
        assignmentAt !== null &&
        assignmentAt - contextAt >= 3 &&
        focalChanges(contextAt, assignmentAt) > 0 &&
        family.checkIds.focal.every((id) => passed(phaseProbe?.checks.focal ?? [], id)) &&
        outputs.some((o) => o.decision > assignmentAt);
      timing.eligible = eligible;
      const checks = [
        { id: 'delayed_relevance_deferred', passed: premature === 0 },
        {
          id: 'delayed_relevance_current_contract',
          passed: adaptedCheck.followup_assignment!(evidence.final),
        },
        {
          id: 'delayed_relevance_followup_completed',
          passed: team.tickets.some(
            (t) => t.id === family.hotfix.id && t.status === 'done',
          ),
        },
      ];
      delayed = {
        assignmentDecision: assignmentAt,
        gapDecisions: assignmentAt === null ? null : assignmentAt - contextAt,
        contentBeforeAssignment:
          early !== null && assignmentAt !== null && early <= assignmentAt,
        laterRetrievalDecision: later?.decision ?? null,
        secondaryChangesBeforeAssignment: premature,
        checks,
      };
      finalBehaviorCorrect =
        assessableRun && eligible ? checks.every((c) => c.passed) : null;
    }
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
      detectionLatency: retrievalLatency,
      // Compatibility field: absent retrieval is not a demonstrated awareness failure.
      // No completed response (or an interrupted run) cannot establish a miss.
      missed:
        content !== null
          ? false
          : responses.length === 0 ||
              CENSORING.includes(termination) ||
              INVALID.includes(termination)
            ? null
            : true,
      observation: {
        firstInputAfterEvent: firstInput,
        responseDecisions: responses.length,
        contentRetrieved: content !== null,
        retrievalLatency,
        finalBehaviorCorrect,
        behaviorCorrectAtFire:
          kind !== 'delayed_context' && probe
            ? (adaptedCheck[kind]?.(probe.checks) ?? null)
            : null,
        compactionsAfterContent:
          content === null
            ? null
            : trace.filter(
                (e) =>
                  e.type === 'compaction' && e.phase === 'start' && e.decision >= content,
              ).length,
      },
      timing,
      ...(suppression ? { suppression } : {}),
      ...(delayed ? { delayed } : {}),
      focalChangesBeforeContent: focalChanges(
        at,
        content === null ? lastDecision : content - 1,
      ),
      commitsBeforeContent:
        commitsAt(content === null ? lastDecision : content - 1) - commitsAt(at),
      toolActionsBeforeContent: actionsBetween(firstInput ?? lastDecision, horizon),
      adapted: finalBehaviorCorrect,
    };
  });

  // Urgent assignment handling.
  const urgent = events.find((e) => e.kind === 'urgent_assignment');
  const withdrawnAt =
    events.find((e) => e.kind === 'urgency_downgrade')?.firedDecision ?? null;
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
  const urgentMetrics: Grade['urgent'] = urgent?.fired
    ? {
        hotfixCorrect:
          withdrawnAt !== null ? null : adaptedCheck.urgent_assignment!(evidence.final),
        ...(withdrawnAt !== null ? { withdrawnDecision: withdrawnAt } : {}),
        hotfixMarkedDone: hotfixDone !== null,
        // Report status ordering descriptively: a safe stopping point can close the
        // focal ticket before incident completion, and later updates can reopen it.
        focalFirstDoneDecision: focalDone,
        hotfixFirstDoneDecision: hotfixDone,
        focalLastDoneDecision:
          actions
            .filter(
              (a) =>
                a.observation.name === 'linear_update_issue_status' &&
                !a.observation.isError &&
                String(a.observation.args['id']).toUpperCase() === family.focal.id &&
                a.observation.args['status'] === 'done',
            )
            .at(-1)?.decision ?? null,
        hotfixDoneBeforeFocalDone:
          withdrawnAt !== null
            ? null
            : hotfixDone !== null && (focalDone === null || hotfixDone <= focalDone),
        focalChangesWhileUrgentOpen:
          urgent.contentDecision === null
            ? null
            : focalChanges(
                urgent.contentDecision,
                Math.min(hotfixDone ?? lastDecision, withdrawnAt ?? lastDecision),
              ),
        hotfixCommitIsolated:
          withdrawnAt !== null
            ? null
            : hotfixCommits.length > 0 &&
              hotfixCommits.every(
                ([, files]) => !files.some((f) => family.focal.paths.includes(f)),
              ),
        resumedFocalAfterHotfix:
          withdrawnAt !== null
            ? null
            : hotfixDone !== null &&
              (focalChanges(hotfixDone, lastDecision) > 0 ||
                (focalDone ?? -1) > hotfixDone),
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
    ...(condition.updates === 'disabled' &&
    assessableRun &&
    trace.some(
      (e) =>
        e.type === 'environment_event' &&
        !e.event.important &&
        outputs.some((o) => o.decision > e.decision),
    )
      ? {
          noiseControlPassed:
            baseFocal.every((c) => c.passed) &&
            tickets.get(family.focal.id)?.status === 'done',
        }
      : {}),
  };

  const validity: Check[] = [
    { id: 'audit_eligible', passed: audit.eligible },
    { id: 'not_invalid_termination', passed: !INVALID.includes(termination) },
    { id: 'script_order', passed: scriptOrdered(trace, condition) },
    { id: 'had_decisions', passed: inputs.length > 0 },
  ];
  const fired = events.filter((e) => e.fired);
  const summary: Grade['summary'] = {
    importantScheduled: script.length,
    importantNotFired: script.length - fired.length,
    importantFired: fired.length,
    importantMissed: fired.filter((e) => e.missed).length,
    contentRetrieved: fired.filter((e) => e.observation?.contentRetrieved).length,
    retrievalUnassessable: fired.filter((e) => e.missed === null).length,
    meanDetectionLatency: mean(
      fired.flatMap((e) => (e.detectionLatency === null ? [] : [e.detectionLatency])),
    ),
    focalChangesBeforeContent: fired.reduce(
      (n, e) => n + (e.focalChangesBeforeContent ?? 0),
      0,
    ),
    commitsBeforeContent: fired.reduce((n, e) => n + (e.commitsBeforeContent ?? 0), 0),
    adaptedFraction: fired.some((e) => e.adapted !== null)
      ? fired.filter((e) => e.adapted).length /
        fired.filter((e) => e.adapted !== null).length
      : null,
    behaviorUnassessable: fired.filter((e) => e.adapted === null).length,
    timingEligible: fired.filter((e) => e.timing?.eligible).length,
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

function scriptOrdered(trace: Event[], condition: Pick<Condition, 'scenario'>) {
  const order = trace.flatMap((e) =>
    e.type === 'environment_event' && e.event.important ? [e.event.kind] : [],
  );
  return order.every((kind, i) => kind === scriptFor(condition)[i]?.kind);
}
