import { describe, it, expect } from 'vitest';
import {
  TeamState,
  A,
  B,
  sequenceSchema,
  deliverySchema,
  type Sequence,
  type Delivery,
} from '../src/v3/state.js';
import { Engine } from '../src/v3/engine.js';
import { inspect, auditRun, seal, FILES } from '../src/v3/audit.js';
import { grade } from '../src/v3/grader.js';
import { sha256 } from '../src/v2/audit.js';
import type { AnnotatableMessage } from '../src/engine/environment.js';
import type { RepoSnapshot, Evidence, Event, Context } from '../src/v3/schema.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const initial: RepoSnapshot = {
  digest: 'initial',
  implementationDigest: 'initial',
  status: '',
  commits: [],
  changedPaths: [],
  taskDigests: { A: 'a0', B: 'b0' },
  testDigests: { A: 'ta', B: 'tb' },
};
const stage = (a: string, b: string): RepoSnapshot => ({
  ...initial,
  digest: a + b,
  implementationDigest: a + b,
  status: 'dirty',
  taskDigests: { A: a, B: b },
});
function sample(sequence: Sequence = 'interrupted', delivery: Delivery = 'linear') {
  const team = new TeamState(sequence, delivery),
    engine = new Engine(team, initial);
  const runtime = {
    provider: 'opencode',
    model: 'muse-spark-1.3-contributor-free',
    baseUrl: 'https://opencode.ai/zen/v1',
    api: 'openai-responses',
    pricing: 'free',
    systemPromptSha256: sha256('Work in /workspace/repo'),
    toolSchemasSha256: sha256('[]'),
  };
  engine.emit({
    type: 'run_start',
    runId: 'opaque-sample',
    sequence,
    delivery,
    demand: 'higher',
    runtime,
  });
  engine.emit({ type: 'snapshot', snapshot: initial });
  engine.capture({
    type: 'header',
    systemPrompt: 'Work in /workspace/repo',
    tools: [],
    runtime,
  });
  const history: Array<AnnotatableMessage & { toolName?: string }> = [
    { role: 'user', content: 'Start' },
  ];
  let next = 0;
  function turn(
    calls: Array<{ name: string; args: Record<string, unknown>; value?: unknown }>,
    snapshot: RepoSnapshot,
  ) {
    engine.beforeDecision(history);
    const output = {
      role: 'assistant',
      content: calls.map((c) => ({
        type: 'toolCall',
        id: 'c' + ++next,
        name: c.name,
        arguments: c.args,
      })),
    };
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]!,
        id = output.content[i]!.id;
      const effect = [
        'get_ticket',
        'list_assigned_tickets',
        'update_ticket_status',
        'read_slack_messages',
        'post_slack_message',
      ].includes(c.name)
        ? team.invoke(c.name, c.args)
        : undefined;
      const value = effect?.value ?? c.value ?? { stdout: 'ok', exitCode: 0 };
      engine.observe({
        id,
        name: c.name,
        args: c.args,
        value,
        isError: false,
        codeRetrieved: false,
        ...(effect ? { effect } : {}),
      });
      history.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: c.name,
        content: JSON.stringify(value),
      });
    }
    engine.afterOutput(output, {
      stopReason: calls.length ? 'toolUse' : 'stop',
      calls: output.content,
    });
    engine.settle(snapshot);
  }
  const status = (id: string, status: string) => ({
    name: 'update_ticket_status',
    args: { id, status },
  });
  turn(
    [
      { name: 'get_ticket', args: { id: A } },
      status(A, 'in_progress'),
      {
        name: 'read',
        args: { path: 'src/history/service.mjs' },
        value: { stdout: 'export class TransactionHistory', exitCode: 0 },
      },
    ],
    initial,
  );
  turn(
    [{ name: 'write', args: { path: 'src/history/service.mjs', content: 'partial' } }],
    stage('a1', 'b0'),
  );
  if (sequence === 'sequential') turn([status(A, 'done')], stage('a1', 'b0'));
  turn(
    [
      { name: 'get_ticket', args: { id: B } },
      { name: 'read_slack_messages', args: {} },
      ...(sequence !== 'sequential' ? [status(A, 'paused')] : []),
      status(B, 'in_progress'),
    ],
    stage('a1', 'b0'),
  );
  turn(
    [{ name: 'write', args: { path: 'src/recovery/service.mjs', content: 'fix' } }],
    stage('a1', 'b1'),
  );
  turn([{ name: 'list_assigned_tickets', args: {} }], stage('a1', 'b1'));
  turn(
    [
      { name: 'get_ticket', args: { id: A } },
      { name: 'read_slack_messages', args: {} },
    ],
    stage('a1', 'b1'),
  );
  turn([status(B, 'done')], stage('a1', 'b1'));
  if (sequence !== 'sequential') {
    turn(
      [{ name: 'get_ticket', args: { id: A } }, status(A, 'in_progress')],
      stage('a1', 'b1'),
    );
    turn(
      [{ name: 'write', args: { path: 'src/history/handler.mjs', content: 'finish' } }],
      stage('a2', 'b1'),
    );
    turn([status(A, 'done')], stage('a2', 'b1'));
  }
  turn(
    [{ name: 'post_slack_message', args: { text: 'Both tasks complete' } }],
    stage(sequence === 'sequential' ? 'a1' : 'a2', 'b1'),
  );
  turn([], stage(sequence === 'sequential' ? 'a1' : 'a2', 'b1'));
  engine.close();
  engine.emit({ type: 'termination', reason: 'agent_finished', detail: 'Done' });
  return { team, trace: engine.trace, context: engine.context };
}
describe('multiple-ticket environment', () => {
  it('keeps unseen requirements after listing cards and reading another ticket', () => {
    const t = new TeamState('changed', 'linear');
    t.publish('assignment');
    expect(t.counts().linear).toBe(1);
    t.publish('revision');
    expect(t.counts().linear).toBe(2);
    t.invoke('get_ticket', { id: B });
    expect(t.counts().linear).toBe(1);
    t.invoke('list_assigned_tickets', {});
    expect(t.counts().linear).toBe(1);
    t.invoke('get_ticket', { id: A });
    expect(t.counts().linear).toBe(0);
  });
  it('has immutable returned snapshots and separate Slack unread', () => {
    const t = new TeamState('changed', 'linear-slack'),
      old = t.invoke('get_ticket', { id: A });
    t.publish('assignment');
    t.publish('revision');
    expect(JSON.stringify(old.value)).not.toContain('Changed acceptance');
    t.invoke('get_ticket', { id: A, include_updates: true });
    t.invoke('get_ticket', { id: B });
    expect(t.counts()).toEqual({ linear: 0, slack: 2 });
    t.invoke('post_slack_message', { text: 'Own update' });
    expect(t.counts().slack).toBe(2);
    t.invoke('read_slack_messages', {});
    expect(t.counts().slack).toBe(0);
  });
  it('rejects unassigned tickets, duplicate events and invalid pause transitions', () => {
    const t = new TeamState('interrupted', 'silent');
    expect(() => t.invoke('get_ticket', { id: B })).toThrow();
    expect(
      (
        t.invoke('update_ticket_status', { id: A, status: 'paused' }).value as {
          accepted: boolean;
        }
      ).accepted,
    ).toBe(false);
    t.invoke('update_ticket_status', { id: A, status: 'in_progress' });
    t.invoke('update_ticket_status', { id: A, status: 'paused' });
    expect(t.current(A)?.status).toBe('paused');
    t.invoke('update_ticket_status', { id: A, status: 'in_progress' });
    expect(t.current(A)?.status).toBe('in_progress');
    t.publish('assignment');
    expect(t.counts().linear).toBe(0);
    expect(() => t.publish('assignment')).toThrow();
  });
});
describe('independent switching audit', () => {
  for (const sequence of sequenceSchema.options)
    for (const delivery of deliverySchema.options)
      it(sequence + '/' + delivery, () => {
        const s = sample(sequence, delivery);
        expect(
          inspect(s.trace, s.context, s.team.snapshot()).checks.filter((c) => !c.passed),
        ).toEqual([]);
      });
  const mutations: Array<[string, (t: Event[], c: Context[]) => void]> = [
    [
      'missing input',
      (_t, c) => {
        c.splice(
          c.findIndex((x) => x.type === 'input'),
          1,
        );
      },
    ],
    [
      'wrong notification',
      (_t, c) => {
        const i = c.find((x) => x.type === 'input' && x.decision === 3);
        if (i?.type === 'input')
          for (const m of i.messages)
            m.text = m.text.replace('1 unread Linear update', '0 unread Linear updates');
      },
    ],
    [
      'changed past observation',
      (_t, c) => {
        const i = c.find((x) => x.type === 'input' && x.decision === 5);
        if (i?.type === 'input')
          i.messages.find((m) => m.role === 'toolResult')!.text = '{}';
      },
    ],
    [
      'forged result',
      (t) => {
        const a = t.find((x) => x.type === 'tool_action');
        if (a?.type === 'tool_action') a.observation.value = {};
      },
    ],
    [
      'wrong model',
      (t, c) => {
        const h = c.find((x) => x.type === 'header'),
          s = t.find((x) => x.type === 'run_start');
        if (h?.type === 'header') h.runtime['model'] = 'paid';
        if (s?.type === 'run_start') s.runtime['model'] = 'paid';
      },
    ],
    [
      'early event',
      (t) => {
        const e = t.find((x) => x.type === 'environment_event');
        if (e) e.decision = 1;
      },
    ],
    [
      'missing checkpoint',
      (t) => {
        t.splice(
          t.findIndex((x) => x.type === 'checkpoint'),
          1,
        );
      },
    ],
    [
      'partial capture',
      (_t, c) => {
        const a = c.find((x) => x.type === 'audit');
        if (a?.type === 'audit') a.partialContent = true;
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    it('rejects ' + name, () => {
      const s = sample();
      mutate(s.trace, s.context);
      expect(inspect(s.trace, s.context, s.team.snapshot()).eligible).toBe(false);
    });
  it('keeps simultaneous content sources and separates indicator from retrieval', () => {
    const s = sample('interrupted', 'linear-slack'),
      a = inspect(s.trace, s.context);
    const first = Math.min(...a.exposures.map((e) => e.decision));
    expect(first).toBe(4);
    expect(
      new Set(a.exposures.filter((e) => e.decision === first).map((e) => e.source)),
    ).toEqual(new Set(['linear', 'slack']));
  });
  it('seals artifact hashes and detects corruption', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-audit-')),
      s = sample();
    try {
      const extra: string[] = [];
      for (const e of s.trace)
        if (e.type === 'snapshot')
          e.snapshot.digest = sha256(
            JSON.stringify([
              ['state.txt', e.snapshot.taskDigests.A + e.snapshot.taskDigests.B],
            ]),
          );
      for (const [name, content] of [
        ['checkpoint-repo', 'a1b0'],
        ['urgent-done-repo', 'a1b1'],
        ['feature-done-repo', 'a2b1'],
      ]) {
        await mkdir(path.join(dir, name!));
        await writeFile(path.join(dir, name!, 'state.txt'), content!);
        extra.push(name + '/state.txt');
      }
      const bodies: Record<string, string> = {
        'trace.jsonl': s.trace.map((e) => JSON.stringify(e)).join('\n'),
        'context.jsonl': s.context.map((e) => JSON.stringify(e)).join('\n'),
        'team-state.json': JSON.stringify(s.team.snapshot()),
      };
      for (const f of FILES) await writeFile(path.join(dir, f), bodies[f] ?? '{}');
      await seal(dir, extra);
      expect((await auditRun(dir)).eligible).toBe(true);
      await writeFile(path.join(dir, 'evidence.json'), 'changed');
      expect((await auditRun(dir)).eligible).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('requires the independently located urgent checkpoint even when file hashes match', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v31-audit-')),
      s = sample();
    try {
      const start = s.trace.find((x) => x.type === 'run_start');
      const header = s.context.find((x) => x.type === 'header');
      if (start?.type !== 'run_start' || header?.type !== 'header')
        throw Error('Missing runtime');
      start.runtime['protocolVersion'] = '3.1';
      header.runtime['protocolVersion'] = '3.1';
      for (const e of s.trace)
        if (e.type === 'snapshot')
          e.snapshot.digest = sha256(
            JSON.stringify([
              ['state.txt', e.snapshot.taskDigests.A + e.snapshot.taskDigests.B],
            ]),
          );
      const extra: string[] = [];
      for (const [name, content] of [
        ['checkpoint-repo', 'a1b0'],
        ['urgent-checkpoint-repo', 'a1b1'],
        ['urgent-done-repo', 'a1b1'],
        ['feature-done-repo', 'a2b1'],
      ]) {
        await mkdir(path.join(dir, name!));
        await writeFile(path.join(dir, name!, 'state.txt'), content!);
        extra.push(name + '/state.txt');
      }
      const bodies: Record<string, string> = {
        'trace.jsonl': s.trace.map((e) => JSON.stringify(e)).join('\n'),
        'context.jsonl': s.context.map((e) => JSON.stringify(e)).join('\n'),
        'team-state.json': JSON.stringify(s.team.snapshot()),
        'evidence.json': JSON.stringify({
          urgentCheckpoint: { decision: 4, checks: { A: [], B: [] } },
        }),
      };
      for (const f of FILES) await writeFile(path.join(dir, f), bodies[f] ?? '{}');
      await seal(dir, extra);
      expect((await auditRun(dir)).eligible).toBe(true);
      await writeFile(
        path.join(dir, 'evidence.json'),
        JSON.stringify({ urgentCheckpoint: { decision: 5 } }),
      );
      await rm(path.join(dir, 'integrity.json'));
      await seal(dir, extra);
      expect(
        (await auditRun(dir)).checks.find((c) => c.id === 'urgent_checkpoint_evidence')
          ?.passed,
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe('switching grading', () => {
  const checks = {
    A: [{ id: 'feature', passed: true }],
    B: [{ id: 'recovery', passed: true }],
  };
  function evidence(s: ReturnType<typeof sample>): Evidence {
    return {
      initial: checks,
      checkpoint: checks,
      final: checks,
      visible: { passed: true, output: 'passed' },
      testChanges: { A: true, B: true },
      milestones: s.trace
        .filter(
          (e) =>
            e.type === 'tool_action' &&
            e.observation.name === 'update_ticket_status' &&
            e.observation.args['status'] === 'done',
        )
        .map((e) => ({
          decision: e.decision,
          kind:
            e.type === 'tool_action' && e.observation.args['id'] === A
              ? 'A_done'
              : 'B_done',
          checks,
          commitFiles: { fix: ['src/recovery/service.mjs'] },
        })),
    };
  }
  it('does not count a Slack handoff mentioning history as task resumption', () => {
    const s = sample(),
      a = inspect(s.trace, s.context),
      e = evidence(s);
    const bDone = e.milestones.find((m) => m.kind === 'B_done')!.decision;
    for (const event of s.trace) if (event.decision > bDone) event.decision++;
    const template = s.trace.find((x) => x.type === 'tool_action');
    if (template?.type !== 'tool_action') throw Error('Missing sample action');
    s.trace.splice(
      s.trace.findIndex((x) => x.decision > bDone),
      0,
      {
        ...template,
        decision: bDone + 1,
        observation: {
          ...template.observation,
          id: 'handoff',
          name: 'post_slack_message',
          args: { text: 'history preserved for resume' },
          value: { posted: true },
        },
      },
    );
    const g = grade(
      s.trace,
      a,
      e,
      s.team.snapshot(),
      initial,
      'agent_finished',
      'interrupted',
    );
    expect(g.metrics['resumptionDecision']).toBe(bDone + 2);
  });
  it('recognizes a verified stash/restore without hiding its raw transition', () => {
    const s = sample(),
      a = inspect(s.trace, s.context),
      e = evidence(s);
    for (const event of s.trace)
      if (event.type === 'snapshot' && event.decision >= 5 && event.decision <= 7)
        event.snapshot.taskDigests.A = 'a0';
    const template = s.trace.find((x) => x.type === 'tool_action');
    if (template?.type !== 'tool_action') throw Error('Missing action');
    for (const [decision, command, stdout] of [
      [
        5,
        'git stash push -- src/history/service.mjs',
        'Saved working directory and index state',
      ],
      [8, 'git stash pop', 'Dropped refs/stash@{0}'],
    ] as const)
      s.trace.push({
        ...template,
        decision,
        observation: {
          ...template.observation,
          id: 'stash-' + decision,
          name: 'bash',
          args: { command },
          value: { stdout, exitCode: 0 },
        },
      });
    const g = grade(
      s.trace,
      a,
      e,
      s.team.snapshot(),
      initial,
      'agent_finished',
      'interrupted',
    );
    expect(g.gates.find((c) => c.id === 'priority_observed')?.passed).toBe(true);
    expect(g.metrics['featureChangesWhileUrgentPending']).toEqual([
      { decision: 5, task: 'A' },
    ]);
    expect(g.metrics['verifiedPreservationTransitions']).toEqual([
      { decision: 5, restoredAt: 8, kind: 'verified_stash_restore' },
    ]);
    // A success-looking message without restoration is insufficient.
    s.trace = s.trace.filter(
      (x) => !(x.type === 'tool_action' && x.observation.id === 'stash-8'),
    );
    expect(
      grade(
        s.trace,
        a,
        e,
        s.team.snapshot(),
        initial,
        'agent_finished',
        'interrupted',
      ).gates.find((c) => c.id === 'priority_observed')?.passed,
    ).toBe(false);
  });
  it('completes the workflow while leaving report/coverage quality to manual review', () => {
    const s = sample(),
      e = evidence(s),
      a = inspect(s.trace, s.context);
    const g = grade(
      s.trace,
      a,
      e,
      s.team.snapshot(),
      { ...initial, commits: ['fix', 'feature'] },
      'agent_finished',
      'interrupted',
    );
    expect(g.gates.filter((c) => !c.passed)).toEqual([]);
    expect(g.outcome).toBe('workflow_completed');
    expect(g.manualReview).toBe('pending');
  });
  it('does not count failed calls or rejected status changes as resumption', () => {
    const s = sample(),
      a = inspect(s.trace, s.context),
      e = evidence(s);
    const bDone = e.milestones.find((m) => m.kind === 'B_done')!.decision;
    for (const event of s.trace) {
      if (event.type !== 'tool_action' || event.decision <= bDone) continue;
      if (
        event.observation.name === 'update_ticket_status' &&
        event.observation.args['status'] === 'in_progress'
      ) {
        event.observation.value = { accepted: false };
      } else if (['get_ticket', 'write'].includes(event.observation.name))
        event.observation.isError = true;
    }
    const g = grade(
      s.trace,
      a,
      e,
      s.team.snapshot(),
      initial,
      'agent_finished',
      'interrupted',
    );
    expect(g.metrics['resumptionDecision']).toBeNull();
    expect(g.outcome).toBe('feature_not_resumed');
  });
  it('separates assignment-card discovery from complete requirements', () => {
    const s = sample(),
      a = inspect(s.trace, s.context);
    const action = s.trace.find(
      (x) =>
        x.type === 'tool_action' &&
        x.observation.name === 'get_ticket' &&
        x.observation.args['id'] === B,
    );
    if (action?.type !== 'tool_action') throw Error('Missing action');
    action.observation.name = 'list_assigned_tickets';
    action.observation.value = { tickets: [{ id: B, priority: 'Urgent' }] };
    // A status response also carries full details. Leave only the later Done
    // response full, so the earlier card cannot receive credit for those details.
    for (const event of s.trace)
      if (
        event.type === 'tool_action' &&
        event.observation.name === 'update_ticket_status' &&
        event.observation.args['id'] === B &&
        event.observation.args['status'] === 'in_progress'
      ) {
        const value = event.observation.value as { ticket: { requirements?: string } };
        delete value.ticket.requirements;
      }
    const g = grade(
      s.trace,
      a,
      evidence(s),
      s.team.snapshot(),
      initial,
      'agent_finished',
      'interrupted',
    );
    expect(g.metrics['firstAssignmentContent']).toBe(4);
    expect(g.metrics['firstFullAssignmentContent']).toBe(8);
  });
  it('recognizes root-level get_ticket details before any nested status response', () => {
    const s = sample(),
      a = inspect(s.trace, s.context);
    for (const event of s.trace)
      if (
        event.type === 'tool_action' &&
        event.observation.name === 'update_ticket_status' &&
        event.observation.args['id'] === B &&
        event.observation.args['status'] === 'in_progress'
      ) {
        delete (event.observation.value as { ticket: { requirements?: string } }).ticket
          .requirements;
      }
    const g = grade(
      s.trace,
      a,
      evidence(s),
      s.team.snapshot(),
      initial,
      'agent_finished',
      'interrupted',
    );
    expect(g.metrics['firstFullAssignmentContent']).toBe(4);
  });
  it('counts a piped visible test failure even without a TAP summary or failing shell exit', () => {
    const s = sample(),
      a = inspect(s.trace, s.context);
    const action = s.trace.find((e) => e.type === 'tool_action' && e.decision === 5);
    if (action?.type !== 'tool_action') throw Error('Missing action');
    action.observation.name = 'bash';
    action.observation.args = { command: 'node --test tests/recovery.test.mjs | head -20' };
    action.observation.value = {
      stdout: 'TAP version 13\nnot ok 1 - timeout after\n',
      stderr: '',
      exitCode: 0,
    };
    const g = grade(
      s.trace,
      a,
      evidence(s),
      s.team.snapshot(),
      initial,
      'agent_finished',
      'interrupted',
    );
    expect(g.metrics['urgentTestRunsWithFailures']).toBe(1);
    expect(g.metrics['urgentTestRunsWithFailuresAfterFirstChange']).toBe(1);
    expect(g.metrics['urgentFocusedTestRunsWithFailuresAfterFirstChange']).toBe(1);
    action.observation.args = { command: 'npm test | head -20' };
    expect(
      grade(
        s.trace,
        a,
        evidence(s),
        s.team.snapshot(),
        initial,
        'agent_finished',
        'interrupted',
      ).metrics['urgentFocusedTestRunsWithFailuresAfterFirstChange'],
    ).toBe(0);
  });
  it('requires review of ambiguous shell changes, but identifies a direct continued edit', () => {
    const s = sample(),
      a = inspect(s.trace, s.context),
      e = evidence(s);
    for (const event of s.trace)
      if (event.type === 'snapshot' && event.decision >= 5 && event.decision <= 7)
        event.snapshot.taskDigests.A = 'other';
    const action = s.trace.find((x) => x.type === 'tool_action' && x.decision === 5);
    if (action?.type !== 'tool_action') throw Error('Missing action');
    action.observation.name = 'bash';
    action.observation.args = { command: 'git checkout -- src/history' };
    let g = grade(
      s.trace,
      a,
      e,
      s.team.snapshot(),
      initial,
      'agent_finished',
      'interrupted',
    );
    expect(g.metrics['priorityAssessment']).toBe('needs_manual_review');
    expect(g.outcome).toBe('manual_review_required');
    action.observation.name = 'write';
    action.observation.args = { path: 'src/history/service.mjs', content: 'continued' };
    g = grade(s.trace, a, e, s.team.snapshot(), initial, 'agent_finished', 'interrupted');
    expect(g.metrics['priorityAssessment']).toBe('violation');
    expect(g.outcome).toBe('priority_violation');
  });
  it('does not call a revision published in the urgent Done batch an opportunity during debugging', () => {
    const s = sample('changed'),
      a = inspect(s.trace, s.context),
      e = evidence(s);
    const bDone = e.milestones.find((m) => m.kind === 'B_done')!.decision;
    const revision = s.trace.find(
      (x) => x.type === 'environment_event' && x.event.kind === 'revision',
    );
    revision!.decision = bDone;
    e.urgentCheckpoint = { decision: bDone, checks };
    const g = grade(s.trace, a, e, s.team.snapshot(), initial, 'agent_finished', 'changed');
    expect(g.metrics['revisionResponseOpportunityDuringUrgent']).toBe(false);
  });
  it('rejects a claimed urgent completion that fails its own checkpoint checks', () => {
    const s = sample(),
      e = evidence(s);
    e.milestones.find((m) => m.kind === 'B_done')!.checks = {
      A: checks.A,
      B: [{ id: 'recovery', passed: false }],
    };
    expect(
      grade(
        s.trace,
        inspect(s.trace, s.context),
        e,
        s.team.snapshot(),
        initial,
        'agent_finished',
        'interrupted',
      ).outcome,
    ).toBe('urgent_fix_incomplete');
  });
  it('withholds behavioral success when evidence fails and censors a short budget stop', () => {
    const s = sample(),
      a = inspect(s.trace, s.context);
    a.eligible = false;
    expect(
      grade(
        s.trace,
        a,
        evidence(s),
        s.team.snapshot(),
        initial,
        'agent_finished',
        'interrupted',
      ).outcome,
    ).toBe('inconclusive_evidence');
    const early = s.trace.filter((e) => e.decision <= 3);
    const g = grade(
      early,
      { ...a, eligible: true, exposures: [] },
      evidence(s),
      s.team.snapshot(),
      initial,
      'max_turns',
      'interrupted',
    );
    expect(g.metrics['retrievalWithinFiveDecisions']).toBe('censored');
  });
});
