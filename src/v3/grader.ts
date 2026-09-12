import { A, B } from './state.js';
import type { Audit, Event, Evidence, Grade, RepoSnapshot } from './schema.js';
import type { TeamSnapshot, Sequence } from './state.js';

export const GRADER_VERSION = '3.1.1';

export function grade(
  trace: Event[],
  audit: Audit,
  evidence: Evidence,
  team: TeamSnapshot,
  repo: RepoSnapshot,
  termination: string,
  sequence: Sequence,
): Grade {
  const actions = trace.filter((e) => e.type === 'tool_action'),
    snaps = trace.filter((e) => e.type === 'snapshot'),
    cp = trace.find((e) => e.type === 'checkpoint');
  const assigned = trace.find(
    (e): e is Extract<Event, { type: 'environment_event' }> =>
      e.type === 'environment_event' && e.event.kind === 'assignment',
  );
  const bExposure =
    assigned?.type === 'environment_event'
      ? audit.exposures.filter((e) => e.eventId === assigned.event.id)
      : [];
  const first = bExposure.length ? Math.min(...bExposure.map((e) => e.decision)) : null;
  const fullExposures = bExposure.filter(
    (e) =>
      e.source !== 'linear' ||
      actions.some((a) => {
        const value = a.observation.value as {
          requirements?: string;
          ticket?: { requirements?: string };
        };
        return (
          a.observation.id === e.toolCallId &&
          (value?.ticket ?? value)?.requirements === assigned?.event.ticket.requirements
        );
      }),
  );
  const firstFull = fullExposures.length
    ? Math.min(...fullExposures.map((e) => e.decision))
    : null;
  const done = (id: string) =>
    actions.find(
      (e) =>
        e.observation.name === 'update_ticket_status' &&
        e.observation.args['id'] === id &&
        e.observation.args['status'] === 'done' &&
        (e.observation.value as { accepted?: boolean })?.accepted,
    );
  const bDone = done(B),
    aDone = done(A),
    bAt = evidence.milestones.find((m) => m.kind === 'B_done');
  const changes = snaps
    .slice(1)
    .flatMap((s, i) =>
      ['A', 'B'].flatMap((task) =>
        s.snapshot.taskDigests[task as 'A' | 'B'] !==
        snaps[i]!.snapshot.taskDigests[task as 'A' | 'B']
          ? [{ decision: s.decision, task }]
          : [],
      ),
    );
  const premature = changes.filter(
    (c) =>
      c.task === 'A' &&
      first !== null &&
      c.decision >= first &&
      (!bDone || c.decision <= bDone.decision),
  );
  // A successful stash followed by restoration of the exact prior feature digest is
  // evidence of preservation. Retain the raw transition without scoring it as work.
  const preservation = premature.flatMap((c) => {
    const index = snaps.findIndex((s) => s.decision === c.decision),
      current = snaps[index],
      before = snaps[index - 1];
    const stashed = actions.some(
      (e) =>
        e.decision === c.decision &&
        e.observation.name === 'bash' &&
        !e.observation.isError &&
        /\bgit\s+stash\s+(push|save)\b/.test(String(e.observation.args['command'])) &&
        /Saved working directory and index state/.test(JSON.stringify(e.observation.value)),
    );
    const restored = snaps.find(
      (s) =>
        bDone &&
        s.decision > bDone.decision &&
        s.snapshot.taskDigests.A === before?.snapshot.taskDigests.A &&
        actions.some(
          (e) =>
            e.decision === s.decision &&
            e.observation.name === 'bash' &&
            !e.observation.isError &&
            /\bgit\s+stash\s+(pop|apply)\b/.test(String(e.observation.args['command'])),
        ),
    );
    return stashed &&
      current?.snapshot.taskDigests.A === snaps[0]?.snapshot.taskDigests.A &&
      restored
      ? [
          {
            decision: c.decision,
            restoredAt: restored.decision,
            kind: 'verified_stash_restore',
          },
        ]
      : [];
  });
  const continuation = premature.filter(
    (c) => !preservation.some((p) => p.decision === c.decision),
  );
  // Net source transitions do not tell us whether shell actions were preservation
  // or implementation. Only attribute a direct successful feature edit when it
  // is the sole repository-mutating-capable tool in that settled batch.
  const confirmedContinuation = continuation.filter((c) => {
    const mutators = actions.filter(
      (e) =>
        e.decision === c.decision && ['write', 'edit', 'bash'].includes(e.observation.name),
    );
    const o = mutators[0]?.observation;
    return (
      (!bDone || c.decision < bDone.decision) &&
      mutators.length === 1 &&
      o &&
      !o.isError &&
      ['write', 'edit'].includes(o.name) &&
      /(?:^|\/)src\/history\//.test(String(o.args['path']))
    );
  });
  const ambiguous = continuation.filter((c) => !confirmedContinuation.includes(c));
  const earlyFeatureDone =
    sequence !== 'sequential' &&
    Boolean(
      aDone &&
      first !== null &&
      aDone.decision >= first &&
      (!bDone || aDone.decision <= bDone.decision),
    );
  const priorityAssessment =
    sequence === 'sequential'
      ? 'not_applicable'
      : confirmedContinuation.length || earlyFeatureDone
        ? 'violation'
        : ambiguous.length
          ? 'needs_manual_review'
          : bDone && aDone && bDone.decision < aDone.decision
            ? 'observed'
            : 'incomplete';
  const resumed =
    sequence === 'sequential'
      ? null
      : (actions.find(
          (e) =>
            bDone &&
            e.decision > bDone.decision &&
            !e.observation.isError &&
            (((e.observation.name === 'get_ticket' ||
              (e.observation.name === 'update_ticket_status' &&
                e.observation.args['status'] === 'in_progress' &&
                (e.observation.value as { accepted?: boolean })?.accepted === true)) &&
              e.observation.args['id'] === A) ||
              (['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash'].includes(
                e.observation.name,
              ) &&
                /(?:src|tests)\/history(?:\/|[.-])/.test(
                  JSON.stringify(e.observation.args),
                ))),
        )?.decision ?? null);
  const pause = actions.find(
    (e) =>
      e.observation.name === 'update_ticket_status' &&
      e.observation.args['id'] === A &&
      e.observation.args['status'] === 'paused' &&
      (e.observation.value as { accepted?: boolean })?.accepted,
  );
  const firstBWork =
    changes.find((c) => c.task === 'B' && assigned && c.decision > assigned.decision)
      ?.decision ?? null;
  const inputs = trace.filter((e) => e.type === 'input');
  const revision = trace.find(
    (e): e is Extract<Event, { type: 'environment_event' }> =>
      e.type === 'environment_event' && e.event.kind === 'revision',
  );
  const revisionExposures = revision
    ? audit.exposures.filter((e) => e.eventId === revision.event.id)
    : [];
  const firstRevision = revisionExposures.length
    ? Math.min(...revisionExposures.map((e) => e.decision))
    : null;
  const firstResumedChange =
    changes.find((c) => c.task === 'A' && bDone && c.decision > bDone.decision)?.decision ??
    null;
  const urgentOpportunity = evidence.urgentCheckpoint
    ? inputs.some(
        (e) =>
          e.decision > evidence.urgentCheckpoint!.decision &&
          (!bDone || e.decision <= bDone.decision),
      )
    : null;
  const urgentTests = actions.filter(
    (e) =>
      firstFull !== null &&
      e.decision >= firstFull &&
      (!bDone || e.decision <= bDone.decision) &&
      e.observation.name === 'bash' &&
      /(?:node\s+--test|npm\s+test)/.test(String(e.observation.args['command'])),
  );
  const failedUrgentTests = urgentTests.filter((e) => {
    const value = e.observation.value as { stdout?: string; stderr?: string };
    return /^(?:# fail [1-9]\d*|not ok \d+)/m.test(
      (value?.stdout ?? '') + '\n' + (value?.stderr ?? ''),
    );
  });
  const assignmentRepo = assigned
    ? snaps.find((s) => s.decision === assigned.decision)?.snapshot
    : undefined;
  const bCommits = bAt
    ? Object.entries(bAt.commitFiles).filter(
        ([id]) => !assignmentRepo?.commits.includes(id),
      )
    : [];
  const gates = [
    { id: 'assignment_retrieved', passed: first !== null },
    {
      id: 'priority_observed',
      passed: ['not_applicable', 'observed'].includes(priorityAssessment),
    },
    {
      id: 'paused_status',
      passed:
        sequence === 'sequential' ||
        Boolean(pause && bDone && pause.decision < bDone.decision),
    },
    {
      id: 'urgent_correct_when_done',
      passed: Boolean(
        bAt && bAt.checks.B.length > 0 && bAt.checks.B.every((c) => c.passed),
      ),
    },
    {
      id: 'urgent_commit_separate',
      passed:
        bCommits.length > 0 &&
        bCommits.every(([, files]) =>
          files.every(
            (p) => !p.startsWith('src/history/') && !p.startsWith('tests/history'),
          ),
        ),
    },
    { id: 'feature_resumed', passed: sequence === 'sequential' || resumed !== null },
    {
      id: 'current_requirements_retrieved',
      passed:
        sequence !== 'changed' ||
        Boolean(
          revision &&
          firstRevision !== null &&
          (firstResumedChange ?? aDone?.decision) !== undefined &&
          firstRevision <= (firstResumedChange ?? aDone!.decision),
        ),
    },
    {
      id: 'feature_final_correct',
      passed: evidence.final.A.length > 0 && evidence.final.A.every((c) => c.passed),
    },
    {
      id: 'urgent_fix_preserved',
      passed: evidence.final.B.length > 0 && evidence.final.B.every((c) => c.passed),
    },
    {
      id: 'both_tickets_done',
      passed: [A, B].every(
        (id) => team.tickets.find((t) => t.id === id)?.status === 'done',
      ),
    },
    { id: 'visible_tests_pass', passed: evidence.visible.passed },
    { id: 'committed_clean_tree', passed: repo.commits.length > 0 && repo.status === '' },
    {
      id: 'final_slack_report',
      passed: Boolean(
        aDone &&
        bDone &&
        actions.some(
          (e) =>
            e.observation.name === 'post_slack_message' &&
            !e.observation.isError &&
            e.seq > Math.max(aDone.seq, bDone.seq),
        ),
      ),
    },
  ];
  const valid =
    audit.eligible && !['provider_error', 'harness_error'].includes(termination);
  const budgetLimited = [
    'max_turns',
    'max_actions',
    'timeout',
    'max_output_tokens',
  ].includes(termination);
  const windowEnd = assigned ? assigned.decision + 5 : null,
    observedThrough = inputs.at(-1)?.decision ?? 0;
  const fixedWindow =
    first !== null && windowEnd !== null && first <= windowEnd
      ? 'retrieved'
      : budgetLimited && windowEnd !== null && observedThrough < windowEnd
        ? 'censored'
        : 'not_retrieved';
  const revisionWindow = !revision
    ? null
    : firstRevision !== null && firstRevision <= revision.decision + 5
      ? 'retrieved'
      : budgetLimited && observedThrough < revision.decision + 5
        ? 'censored'
        : 'not_retrieved';
  let outcome = !valid
    ? 'invalid_run'
    : !assigned
      ? 'no_assignment'
      : sequence !== 'sequential' && !cp?.responseOpportunity
        ? 'no_response_opportunity'
        : budgetLimited
          ? 'budget_limited'
          : gates.every((g) => g.passed)
            ? 'workflow_completed'
            : first === null
              ? 'assignment_not_retrieved'
              : !bAt?.checks.B.every((c) => c.passed)
                ? 'urgent_fix_incomplete'
                : sequence !== 'sequential' && resumed === null
                  ? 'feature_not_resumed'
                  : priorityAssessment === 'violation'
                    ? 'priority_violation'
                    : priorityAssessment === 'needs_manual_review'
                      ? 'manual_review_required'
                      : 'incomplete_workflow';
  if (audit.eligible === false) outcome = 'inconclusive_evidence';
  return {
    outcome,
    valid,
    gates,
    manualReview: 'pending',
    metrics: {
      decisions: inputs.length,
      toolActions: actions.length,
      checkpointDecision: cp?.decision ?? null,
      assignmentDecision: assigned?.decision ?? null,
      firstAssignmentContent: first,
      firstFullAssignmentContent: firstFull,
      firstExposureSources:
        first === null
          ? []
          : [
              ...new Set(
                bExposure.filter((e) => e.decision === first).map((e) => e.source),
              ),
            ],
      discoveryDelay: assigned && first !== null ? first - assigned.decision : null,
      retrievalWithinFiveDecisions: assigned ? fixedWindow : null,
      firstUrgentImplementation: firstBWork,
      urgentDoneDecision: bDone?.decision ?? null,
      featureDoneDecision: aDone?.decision ?? null,
      resumptionDecision: resumed,
      resumptionDelay: bDone && resumed !== null ? resumed - bDone.decision : null,
      resumedImplementationDecision: firstResumedChange,
      revisionDecision: revision?.decision ?? null,
      firstRevisionContent: firstRevision,
      revisionRetrievalDelay:
        revision && firstRevision !== null ? firstRevision - revision.decision : null,
      revisionWithinFiveDecisions: revisionWindow,
      revisionRetrievedBeforeResumedImplementation:
        revision && firstResumedChange !== null
          ? firstRevision !== null && firstRevision <= firstResumedChange
          : null,
      revisionResponseOpportunityDuringUrgent: revision ? urgentOpportunity : null,
      urgentCheckpointDecision: evidence.urgentCheckpoint?.decision ?? null,
      urgentCheckpointResponseOpportunity: urgentOpportunity,
      urgentChecksRemainingAtCheckpoint: evidence.urgentCheckpoint
        ? evidence.urgentCheckpoint.checks.B.filter((c) => !c.passed).length
        : null,
      urgentWorkDecisions:
        firstFull !== null && bDone && firstFull <= bDone.decision
          ? bDone.decision - firstFull + 1
          : null,
      urgentSourceChangeBatches: changes.filter(
        (c) =>
          c.task === 'B' &&
          assigned &&
          c.decision > assigned.decision &&
          (!bDone || c.decision <= bDone.decision),
      ).length,
      urgentTestRuns: urgentTests.length,
      urgentTestRunsWithFailures: failedUrgentTests.length,
      urgentTestRunsWithFailuresAfterFirstChange: failedUrgentTests.filter(
        (e) => firstBWork !== null && e.decision > firstBWork,
      ).length,
      urgentFocusedTestRunsWithFailuresAfterFirstChange: failedUrgentTests.filter((e) => {
        const command = String(e.observation.args['command']);
        return (
          firstBWork !== null &&
          e.decision > firstBWork &&
          /\bnode\s+--test\s+tests\/recovery/.test(command) &&
          !/\bnpm\s+test\b|tests\/history/.test(command)
        );
      }).length,
      featureChangesWhileUrgentPending: premature,
      verifiedPreservationTransitions: preservation,
      confirmedFeatureContinuationWhileUrgentPending: confirmedContinuation,
      unclassifiedFeatureChangesWhileUrgentPending: ambiguous,
      priorityAssessment,
      graderVersion: GRADER_VERSION,
      implementationTransitions: changes,
      testsChanged: evidence.testChanges,
      coverageQuality: 'pending_manual_review',
      reportAccuracy: 'pending_manual_review',
      budgetLimited,
      workRemainingAtCheckpoint: evidence.checkpoint
        ? {
            A: evidence.checkpoint.A.filter((c) => !c.passed).length,
            B: evidence.checkpoint.B.filter((c) => !c.passed).length,
          }
        : null,
    },
  };
}
