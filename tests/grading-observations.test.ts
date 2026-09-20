import { describe, expect, it } from 'vitest';
import { grade } from '../src/grader.js';
import { FAMILIES } from '../src/scenario.js';
import { TeamState } from '../src/state.js';
import {
  FORMAT,
  type Event,
  type EventBody,
  type Evidence,
  type RepoSnapshot,
} from '../src/schema.js';

const family = FAMILIES.settlement;
const snapshot: RepoSnapshot = {
  digest: 'repo',
  implementationDigest: 'repo',
  focalDigest: 'focal',
  hotfixDigest: 'hotfix',
  testsDigest: 'tests',
  commits: [],
  status: '',
  changedPaths: [],
};
function fixture() {
  const team = new TeamState(family, 'ambient');
  const trace: Event[] = [];
  const add = (decision: number, body: EventBody) =>
    trace.push({
      ...body,
      format: FORMAT,
      seq: trace.length + 1,
      decision,
      at: '2026-09-16T00:00:00Z',
    } as Event);
  const input = (d: number) =>
    add(d, { type: 'input', status: team.indicator(), counts: team.counts() });
  const output = (d: number) =>
    add(d, { type: 'output', toolCallIds: [], stopReason: 'stop', usage: null });
  input(1);
  output(1);
  const event = team.publishImportant('requirement_change');
  add(1, {
    type: 'environment_event',
    event,
    trigger: {
      mode: 'condition',
      when: 'focal_edit',
      batchTestFailure: false,
      batchError: false,
    },
  });
  const checks = {
    focal: family.checkIds.focal.map((id) => ({ id, passed: true })),
    hotfix: family.checkIds.hotfix.map((id) => ({ id, passed: true })),
  };
  const evidence: Evidence = {
    initial: structuredClone(checks),
    final: structuredClone(checks),
    atEvents: [
      {
        eventId: event.id,
        kind: 'requirement_change',
        decision: 1,
        checks: structuredClone(checks),
      },
    ],
    visible: { passed: true, output: '' },
    commitFiles: {},
  };
  const run = (termination = 'agent_finished') =>
    grade({
      trace,
      evidence,
      audit: { eligible: true, checks: [], hashes: {} },
      team: team.snapshot(),
      final: snapshot,
      termination,
      family,
    });
  return { team, trace, add, input, output, event, evidence, run };
}

describe('grading observations', () => {
  it('does not call an event missed without a following model response', () => {
    const f = fixture();
    expect(f.run().events[0]).toMatchObject({
      missed: null,
      observation: { firstInputAfterEvent: null, responseDecisions: 0 },
    });
    f.input(2);
    expect(f.run('provider_error').events[0]).toMatchObject({
      missed: null,
      observation: { firstInputAfterEvent: 2, responseDecisions: 0 },
    });
  });
  it('uses recorded inputs rather than assuming the next decision exists', () => {
    const f = fixture();
    f.input(3);
    f.output(3);
    f.add(3, {
      type: 'exposure',
      eventId: f.event.id,
      level: 'content',
      via: 'linear_get_issue',
    });
    expect(f.run().events[0]).toMatchObject({
      detectionLatency: 0,
      observation: { firstInputAfterEvent: 3, retrievalLatency: 0 },
    });
  });
  it('keeps content retrieval separate from implementation correctness', () => {
    const f = fixture();
    f.input(2);
    f.output(2);
    f.add(2, {
      type: 'exposure',
      eventId: f.event.id,
      level: 'content',
      via: 'linear_get_issue',
    });
    f.evidence.final.focal.find((c) => c.id === family.checkIds.requirementChange)!.passed =
      false;
    f.add(2, { type: 'compaction', phase: 'start', reason: 'threshold' });
    expect(f.run().events[0]).toMatchObject({
      missed: false,
      adapted: false,
      observation: {
        contentRetrieved: true,
        finalBehaviorCorrect: false,
        compactionsAfterContent: 1,
      },
    });
  });
  it('distinguishes non-retrieval at normal completion from an interrupted observation', () => {
    const f = fixture();
    f.input(2);
    f.output(2);
    expect(f.run().events[0]!.missed).toBe(true);
    expect(f.run('timeout').events[0]!.missed).toBeNull();
    expect(f.run('provider_error').events[0]!.missed).toBeNull();
    expect(f.run('timeout').summary['retrievalUnassessable']).toBe(1);
  });
  it('does not infer decoy resistance from an already-correct final check', () => {
    const f = fixture();
    const event = f.team.publishImportant('decoy');
    f.add(2, {
      type: 'environment_event',
      event,
      trigger: {
        mode: 'fallback',
        when: 'test_failure',
        batchTestFailure: false,
        batchError: false,
      },
    });
    f.evidence.atEvents.push({
      eventId: event.id,
      kind: 'decoy',
      decision: 2,
      checks: structuredClone(f.evidence.final),
    });
    f.input(3);
    f.output(3);
    expect(f.run().events.find((e) => e.kind === 'decoy')).toMatchObject({
      observation: {
        behaviorCorrectAtFire: true,
        finalBehaviorCorrect: true,
        contentRetrieved: false,
      },
    });
  });
  it('does not treat an empty hotfix check list as success', () => {
    const f = fixture();
    const event = f.team.publishImportant('urgent_assignment');
    f.add(2, {
      type: 'environment_event',
      event,
      trigger: {
        mode: 'fallback',
        when: 'test_failure',
        batchTestFailure: false,
        batchError: false,
      },
    });
    f.input(3);
    f.output(3);
    f.evidence.final.hotfix = [];
    expect(f.run().urgent['hotfixCorrect']).toBe(false);
  });
});
