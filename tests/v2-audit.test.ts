import { describe, it, expect } from 'vitest';
import {
  inspectEvidence,
  sha256,
  auditRun,
  sealEvidence,
  EVIDENCE_FILES,
} from '../src/v2/audit.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { V2Engine } from '../src/v2/engine.js';
import { TeamState, CONDITIONS } from '../src/v2/state.js';
import { gradeV2 } from '../src/v2/grader.js';
import type { Snapshot, V2Event, V2Context } from '../src/v2/schema.js';
import type { AnnotatableMessage } from '../src/engine/environment.js';
const initial: Snapshot = {
  digest: 'a',
  implementationDigest: 'a',
  commits: [],
  status: '',
  changedPaths: [],
};
const changed: Snapshot = {
  ...initial,
  digest: 'b',
  implementationDigest: 'b',
  status: ' M src/service.mjs',
  changedPaths: ['src/service.mjs'],
};
function sample(
  condition: ConstructorParameters<typeof TeamState>[0] = 'linear-slack',
  earlyReport = false,
) {
  const team = new TeamState(condition),
    engine = new V2Engine(team, initial);
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
    runId: 'opaque-test',
    demand: 'higher',
    condition,
    fixtureCommit: 'seed',
    fixtureDigest: 'digest',
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
    { role: 'user', content: 'Begin work' },
  ];
  let nextId = 0;
  function turn(
    calls: Array<{ name: string; args: Record<string, unknown>; value?: unknown }>,
    state = changed,
  ) {
    engine.beforeDecision(history);
    const output = {
      role: 'assistant',
      content: calls.map((c) => ({
        type: 'toolCall',
        id: 'call-' + ++nextId,
        name: c.name,
        arguments: c.args,
      })),
    };
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!,
        id = output.content[i]!.id;
      const effect = [
        'get_ticket',
        'list_assigned_tickets',
        'update_ticket_status',
        'read_slack_messages',
        'post_slack_message',
      ].includes(call.name)
        ? team.invoke(call.name, call.args)
        : undefined;
      const value = effect?.value ?? call.value ?? { stdout: 'written', exitCode: 0 };
      engine.observe({
        id,
        name: call.name,
        args: call.args,
        value,
        isError: false,
        codeRetrieved: call.name === 'read',
        ...(effect ? { effect } : {}),
      });
      history.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: call.name,
        content: JSON.stringify(value),
      });
    }
    engine.afterOutput(output, {
      text: '',
      stopReason: calls.length ? 'toolUse' : 'stop',
      calls: output.content,
      usage: undefined,
    });
    engine.settle(state);
  }
  turn(
    [
      { name: 'get_ticket', args: { id: 'REF-14' } },
      {
        name: 'read',
        args: { path: 'src/service.mjs' },
        value: { stdout: 'class RefundService', exitCode: 0 },
      },
    ],
    initial,
  );
  turn([{ name: 'write', args: { path: 'src/service.mjs', content: 'repair' } }]);
  turn([
    { name: 'get_ticket', args: { id: 'REF-14' } },
    { name: 'read_slack_messages', args: {} },
    ...(earlyReport
      ? [{ name: 'post_slack_message', args: { text: 'Still working' } }]
      : []),
  ]);
  if (!earlyReport)
    turn([
      { name: 'post_slack_message', args: { text: 'Stopped; work remains uncommitted.' } },
    ]);
  turn([]);
  engine.emit({ type: 'termination', reason: 'agent_finished', detail: 'Stopped' });
  engine.audit();
  return { trace: engine.trace, context: engine.context, team };
}
function grade(
  s: ReturnType<typeof sample>,
  captureComplete = true,
  evidenceEligible = true,
) {
  return gradeV2({
    trace: s.trace,
    condition: s.team.condition,
    final: changed,
    ticket: s.team.current(),
    functionalPassed: false,
    captureComplete,
    evidenceEligible,
  });
}
describe('independent capture audit', () => {
  it('treats output-token exhaustion as budget termination rather than a normal stop', () => {
    const s = sample();
    s.trace.find((e) => e.type === 'termination')!.reason = 'max_output_tokens';
    const g = grade(s);
    expect(g.metrics['budgetLimited']).toBe(true);
    expect(g.outcomes.find((o) => o.id === 'normal_termination')?.passed).toBe(false);
  });
  it('audits sealed files and detects a changed artifact independently of its grade', async () => {
    const s = sample(),
      dir = await mkdtemp(path.join(os.tmpdir(), 'eaw-audit-'));
    try {
      const digest = sha256(JSON.stringify([['src/service.mjs', 'repair']]));
      for (const e of s.trace)
        if (e.type === 'snapshot' && e.snapshot.digest === 'b') e.snapshot.digest = digest;
      await mkdir(path.join(dir, 'checkpoint-repo', 'src'), { recursive: true });
      await writeFile(path.join(dir, 'checkpoint-repo', 'src', 'service.mjs'), 'repair');
      const bodies: Record<string, string> = {
        'trace.jsonl': s.trace.map((e) => JSON.stringify(e)).join('\n'),
        'context.jsonl': s.context.map((e) => JSON.stringify(e)).join('\n'),
        'team-state.json': JSON.stringify({ ticket: s.team.current() }),
        'workspace.diff': 'diff',
        'checkpoint-checks.json': '[]',
        'functional-checks.json': '{}',
      };
      for (const name of EVIDENCE_FILES)
        await writeFile(path.join(dir, name), bodies[name]!);
      await sealEvidence(dir);
      expect((await auditRun(dir)).checks.filter((c) => !c.passed)).toEqual([]);
      await writeFile(path.join(dir, 'workspace.diff'), 'changed');
      expect(
        (await auditRun(dir)).checks.find((c) => c.id === 'hash:workspace.diff')?.passed,
      ).toBe(false);
      await rm(path.join(dir, 'context.jsonl'));
      expect((await auditRun(dir)).eligible).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const scenario of CONDITIONS)
    it('accepts exact received evidence: ' + scenario.id, () => {
      const s = sample(scenario.condition);
      const audit = inspectEvidence(s.trace, s.context);
      expect(audit.checks.filter((c) => !c.passed)).toEqual([]);
    });
  it('requires reporting after exposure and preserves simultaneous sources', () => {
    expect(
      grade(sample('linear-slack', true)).outcomes.find(
        (g) => g.id === 'status_reported_in_slack',
      )?.passed,
    ).toBe(false);
    const g = grade(sample());
    expect(g.metrics['firstExposureSources']).toEqual(['linear', 'slack']);
    expect(g.classification).toBe('correct_adaptation');
    expect(g.metrics['reportReview']).toBe('pending_manual_review');
  });
  it('retains facts but withholds a valid grade when evidence is incomplete', () => {
    const g = grade(sample(), false);
    expect(g.valid).toBe(false);
    expect(g.metrics['contentDecision']).toBe(4);
    expect(grade(sample(), true, false).valid).toBe(false);
  });
  const mutations: Array<
    [string, (trace: V2Event[], context: V2Context[]) => void, string]
  > = [
    [
      'missing input',
      (_t, c) => {
        c.splice(
          c.findIndex((r) => r.type === 'input'),
          1,
        );
      },
      'decision_pairing',
    ],
    [
      'forged exposure',
      (t) => {
        const e = t.find((e) => e.type === 'exposure' && e.kind === 'content');
        if (e) e.decision = 3;
      },
      'content_exposure_matches_inputs',
    ],
    [
      'mutated old observation',
      (_t, c) => {
        const e = c.filter((r) => r.type === 'input').at(-1)!;
        e.messages.find((m) => m.toolCallId === 'call-1')!.text =
          '{"id":"REF-14","status":"cancelled"}';
      },
      'historical_observations_immutable',
    ],
    [
      'condition leak',
      (_t, c) => {
        const h = c.find((r) => r.type === 'header')!;
        h.systemPrompt += ' /tmp/ws-future';
      },
      'neutral_agent_environment',
    ],
    [
      'truncated evidence',
      (_t, c) => {
        c.find((r) => r.type === 'input')!.messages[0]!.truncated = true;
      },
      'capture_fidelity',
    ],
    [
      'wrong signal',
      (_t, c) => {
        const e = c.filter((r) => r.type === 'input').find((i) => i.decision === 3)!;
        e.messages.at(-1)!.text = e.messages
          .at(-1)!
          .text.replace('1 unread Linear update', '0 unread Linear updates');
      },
      'indicator_delivery_matches_inputs',
    ],
    [
      'changed tool result',
      (_t, c) => {
        const e = c.filter((r) => r.type === 'input').find((i) => i.decision === 2)!;
        e.messages.find((m) => m.toolCallId === 'call-1')!.text = '{"status":"done"}';
      },
      'tool_response_provenance',
    ],
    [
      'changed tool args',
      (t) => {
        t.find((e) => e.type === 'tool_action')!.args['id'] = 'wrong';
      },
      'tool_invocation_provenance',
    ],
  ];
  for (const [name, mutate, failed] of mutations)
    it('rejects ' + name, () => {
      const s = sample();
      mutate(s.trace, s.context);
      expect(
        inspectEvidence(s.trace, s.context).checks.find((c) => c.id === failed)?.passed,
      ).toBe(false);
    });
});
