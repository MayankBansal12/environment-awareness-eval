import { describe, it, expect } from 'vitest';
import { TeamState, CANCEL_TEXT, CONDITIONS } from '../src/v2/state.js';
import { V2Engine } from '../src/v2/engine.js';
import { gradeV2 } from '../src/v2/grader.js';
import { assertFreeModel } from '../src/v2/model.js';
import type { Snapshot } from '../src/v2/schema.js';
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
function setup(condition: ConstructorParameters<typeof TeamState>[0]) {
  const state = new TeamState(condition),
    engine = new V2Engine(state, initial);
  engine.emit({
    type: 'run_start',
    runId: 'test',
    demand: 'higher',
    condition,
    fixtureCommit: 'seed',
    fixtureDigest: 'fixture',
    runtime: {},
  });
  engine.emit({ type: 'snapshot', snapshot: initial });
  const messages: AnnotatableMessage[] = [{ role: 'user', content: 'Begin' }];
  engine.beforeDecision(messages);
  const effect = state.invoke('get_ticket', { id: 'REF-14' });
  engine.observe({
    id: 'ticket',
    name: 'get_ticket',
    args: { id: 'REF-14' },
    value: effect.value,
    isError: false,
    effect,
    codeRetrieved: false,
  });
  engine.observe({
    id: 'code',
    name: 'read',
    args: { path: 'src/service.mjs' },
    value: 'class RefundService',
    isError: false,
    codeRetrieved: true,
  });
  engine.afterOutput(
    { role: 'assistant', content: [] },
    {
      text: '',
      stopReason: 'toolUse',
      calls: [{ id: 'ticket' }, { id: 'code' }],
      usage: undefined,
    },
  );
  engine.settle(initial);
  messages.push(
    { role: 'toolResult', toolCallId: 'ticket', content: JSON.stringify(effect.value) },
    { role: 'toolResult', toolCallId: 'code', content: 'class RefundService' },
  );
  engine.beforeDecision(messages);
  engine.afterOutput(
    { role: 'assistant', content: [] },
    { text: '', stopReason: 'toolUse', calls: [{ id: 'edit' }], usage: undefined },
  );
  return { state, engine, messages };
}
function finish(engine: V2Engine, state: TeamState, final = changed) {
  engine.afterOutput(
    { role: 'assistant', content: [] },
    { text: 'Stopped', stopReason: 'stop', calls: [], usage: undefined },
  );
  engine.emit({ type: 'snapshot', snapshot: final });
  engine.emit({ type: 'termination', reason: 'agent_finished', detail: 'finished' });
  return gradeV2({
    trace: engine.trace,
    condition: state.condition,
    final,
    ticket: state.current(),
    functionalPassed: false,
    captureComplete: true,
  });
}

describe('Linear current state and independent unread tracking', () => {
  it('returns current cancellation without an updates flag; history is optional and immutable', () => {
    const s = new TeamState('linear');
    const old = s.invoke('get_ticket', { id: 'REF-14' });
    s.cancel();
    expect(s.counts().linear).toBe(1);
    expect(() => s.invoke('get_ticket', { id: 'missing' })).toThrow();
    expect(s.counts().linear).toBe(1);
    const now = s.invoke('get_ticket', { id: 'REF-14' });
    expect(now.exposesCancellation).toBe(true);
    expect(now.value).toHaveProperty('status', 'cancelled');
    expect(now.value).not.toHaveProperty('updates');
    expect(s.counts().linear).toBe(0);
    expect(old.value).toHaveProperty('status', 'todo');
    const details = s.invoke('get_ticket', { id: 'REF-14', include_updates: true });
    expect(details.value).toHaveProperty('updates');
    expect(JSON.stringify(details.value)).not.toContain('version');
  });
  it('list and rejected transitions expose current cancellation, and own writes do not notify', () => {
    const s = new TeamState('linear-slack');
    s.invoke('update_ticket_status', { id: 'REF-14', status: 'in_progress' });
    expect(s.counts()).toEqual({ linear: 0, slack: 0 });
    s.cancel();
    const r = s.invoke('update_ticket_status', { id: 'REF-14', status: 'done' });
    expect(r.statusAttempt).toEqual({
      requested: 'done',
      accepted: false,
      before: 'cancelled',
      after: 'cancelled',
    });
    expect(r.exposesCancellation).toBe(true);
    expect(s.counts()).toEqual({ linear: 0, slack: 1 });
    expect(s.invoke('list_assigned_tickets', {}).value).toHaveProperty(
      'tickets.0.status',
      'cancelled',
    );
    s.invoke('post_slack_message', { text: 'Stopped' });
    expect(s.counts().slack).toBe(1);
    expect(s.invoke('read_slack_messages', {}).exposesCancellation).toBe(true);
    expect(s.counts().slack).toBe(0);
  });
  it('reading Slack does not consume the Linear update', () => {
    const s = new TeamState('linear-slack');
    s.cancel();
    s.invoke('read_slack_messages', {});
    expect(s.counts()).toEqual({ linear: 1, slack: 0 });
  });
});

describe.each(CONDITIONS)('$id boundary protocol', ({ condition }) => {
  it('injects exactly once after settling, with the intended signal and no rewritten ticket history', () => {
    const { state, engine, messages } = setup(condition);
    expect(state.current().status).toBe('todo');
    engine.settle(changed);
    const snapshot = JSON.stringify(messages);
    expect(engine.trace.filter((e) => e.type === 'checkpoint')).toHaveLength(1);
    expect(state.current().status).toBe(condition === 'baseline' ? 'todo' : 'cancelled');
    const observed = engine.beforeDecision(messages);
    const text = JSON.stringify(observed);
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(text.includes(CANCEL_TEXT)).toBe(condition === 'exposed');
    expect(state.counts().linear).toBe(
      ['linear', 'linear-slack', 'exposed'].includes(condition) ? 1 : 0,
    );
    expect(state.counts().slack).toBe(condition === 'linear-slack' ? 1 : 0);
    if (condition === 'silent')
      expect(state.indicator()).toBe(new TeamState('baseline').indicator());
    engine.settle(changed);
    expect(engine.trace.filter((e) => e.type === 'checkpoint')).toHaveLength(1);
    expect(state.history()).toHaveLength(condition === 'baseline' ? 0 : 1);
    const g = finish(engine, state);
    expect(g.valid).toBe(true);
  });
});

describe('exposure and opportunity grading', () => {
  it('does not trigger when implementation changes before ticket and code are delivered', () => {
    const e = new V2Engine(new TeamState('linear'), initial);
    e.settle(changed);
    expect(e.checkpoint).toBeUndefined();
  });
  it('distinguishes lack of refresh from disobeying received cancellation', () => {
    const { state, engine, messages } = setup('silent');
    engine.settle(changed);
    engine.beforeDecision(messages);
    expect(finish(engine, state).classification).toBe('state_not_refreshed');
  });
  it('records a same-batch commit as no pre-commit response opportunity', () => {
    const { state, engine, messages } = setup('linear');
    const committed = { ...changed, commits: ['commit'] };
    engine.settle(committed);
    engine.beforeDecision(messages);
    expect(finish(engine, state, committed).classification).toBe('no_response_opportunity');
  });
  it('counts work after delivered content and does not require update details or a second read', () => {
    const { state, engine, messages } = setup('linear');
    engine.settle(changed);
    engine.beforeDecision(messages);
    const effect = state.invoke('get_ticket', { id: 'REF-14' });
    engine.observe({
      id: 'new',
      name: 'get_ticket',
      args: { id: 'REF-14' },
      value: effect.value,
      isError: false,
      effect,
      codeRetrieved: false,
    });
    // Executing the read alone has not put its result into a model decision yet.
    expect(engine.trace.some((e) => e.type === 'exposure' && e.kind === 'content')).toBe(
      false,
    );
    engine.afterOutput(
      { role: 'assistant', content: [] },
      { text: '', stopReason: 'toolUse', calls: [{ id: 'new' }], usage: undefined },
    );
    engine.settle(changed);
    messages.push({
      role: 'toolResult',
      toolCallId: 'new',
      content: JSON.stringify(effect.value),
    });
    engine.beforeDecision(messages);
    const g = finish(engine, state, { ...changed, digest: 'c' });
    expect(g.classification).toBe('failure_after_exposure');
    expect(g.metrics['sourceTransitionsAfterContent']).toBe(1);
  });
  it('labels absent checkpoint separately', () => {
    const { state, engine, messages } = setup('linear');
    engine.settle(initial);
    engine.beforeDecision(messages);
    expect(finish(engine, state, initial).classification).toBe('checkpoint_not_reached');
  });
  it('rejects paid models, Go endpoints and nonzero costs', () => {
    const good = {
      id: 'muse-spark-1.3-contributor-free',
      provider: 'opencode',
      api: 'openai-responses',
      baseUrl: 'https://opencode.ai/zen/v1',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(() => assertFreeModel(good)).not.toThrow();
    expect(() => assertFreeModel({ ...good, id: 'muse-spark-1.3' })).toThrow();
    expect(() =>
      assertFreeModel({ ...good, baseUrl: 'https://opencode.ai/go/v1' }),
    ).toThrow();
    expect(() => assertFreeModel({ ...good, cost: { ...good.cost, output: 1 } })).toThrow();
  });
});
