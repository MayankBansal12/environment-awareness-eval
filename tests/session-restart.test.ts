/**
 * Turn identity must survive a provider error restarting the agent session.
 *
 * Pi restarts `AssistantMessage.turnIndex` at 0 when a provider error forces a new
 * session. The engine used to record observed test runs against its own monotonic turn
 * count while the trigger compared them to the runtime's index, so after a restart the two
 * drifted apart by the length of the abandoned session. Observed live on the free tier in
 * 8 of 18 runs:
 *
 *   - `v4-m12-cancel-ambient-late` drifted by 7. `tests_first_pass` matched the test from
 *     decision 11 only once the runtime's counter reached 11 again, firing at decision 18.
 *     The cancellation was delivered seven decisions late and the run graded invalid.
 *   - `v4-m13-cancel-ambient-late` drifted by 11. The runtime's counter never caught up,
 *     the trigger never fired, and no environment event was created, delivered or exposed.
 *     29 decisions of a cancellation scenario in which the cancellation never happened.
 *
 * The second is the failure worth guarding: the run completes and looks clean, having
 * measured nothing. `settleTurn` therefore derives turn identity from the engine's own
 * ordinal and ignores whatever the runtime reports.
 */

import { describe, expect, it } from 'vitest';

import { ExperimentEngine, SlackState } from '../src/engine/experiment.js';
import { getScenario } from '../src/scenarios/catalog.js';
import type { TraceEvent } from '../src/trace/schema.js';
import type { WorkspaceSnapshot } from '../src/workspace/snapshot.js';

function snap(mutated: boolean): WorkspaceSnapshot {
  return {
    headCommit: 'a'.repeat(40),
    commitsAheadOfFixture: 0,
    commits: [],
    sourceMutated: mutated,
    workingTreeDirty: mutated,
    statusPorcelain: mutated ? ' M src/a.ts' : '',
    trackedSourceDigest: mutated ? 'changed' : 'base',
    changedWatchedFiles: mutated ? ['src/a.ts'] : [],
    untrackedWatchedFiles: [],
    changedFiles: mutated ? ['src/a.ts'] : [],
    untrackedFiles: [],
  };
}

function harness(scenarioId: string) {
  const slack = new SlackState();
  slack.post({
    sender: 'Maya',
    senderRole: 'ticket_owner',
    text: 'ticket',
    mentionsAgent: true,
    logicalTime: -1,
  });
  slack.readUnread();

  const traces: TraceEvent[] = [];
  let current = snap(false);
  const engine = new ExperimentEngine({
    scenario: getScenario(scenarioId),
    slack,
    sink: (event) => traces.push(event),
    snapshot: async () => current,
    steer: async () => {},
    limits: { maxTurns: 40, maxActions: 120 },
    now: () => new Date('2024-01-01T00:00:00.000Z'),
  });
  return {
    engine,
    traces,
    setSnapshot: (mutated: boolean) => {
      current = snap(mutated);
    },
  };
}

/** One turn that calls no tools — the shape of an aborted turn before a restart. */
async function idleTurn(setup: ReturnType<typeof harness>): Promise<void> {
  setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
  await setup.engine.settleTurn({
    assistantText: '',
    stopReason: 'error',
    toolCallNames: [],
  });
}

describe('turn identity across a session restart', () => {
  it('numbers turns monotonically even though the runtime restarts at zero', async () => {
    const setup = harness('cancel-ambient-late');

    // Session one: six turns, then a provider error.
    for (let index = 0; index < 6; index += 1) await idleTurn(setup);
    // Session two restarts the runtime's counter at 0; the engine's must not restart.
    for (let index = 0; index < 3; index += 1) await idleTurn(setup);

    const turns = setup.traces.filter((event) => event.type === 'assistant_turn');
    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(turns.map((turn) => turn.turnIndex)).size).toBe(turns.length);
  });

  it('fires tests_first_pass in the turn the suite actually passed in', async () => {
    const setup = harness('cancel-ambient-late');

    // Seven turns burned by an aborted session, so the runtime index is now 7 behind.
    for (let index = 0; index < 7; index += 1) await idleTurn(setup);

    // The restarted session mutates source, then runs a full suite that passes.
    setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
    setup.engine.observeTool({
      toolCallId: 'edit-1',
      toolName: 'edit',
      input: { path: 'src/a.ts' },
      outputText: 'ok',
      isError: false,
    });
    setup.setSnapshot(true);
    setup.engine.observeTool({
      toolCallId: 'test-1',
      toolName: 'bash',
      input: { command: 'pnpm test' },
      outputText: 'Test Files 3 passed\nTests 12 passed',
      isError: false,
    });
    await setup.engine.settleTurn({
      assistantText: '',
      stopReason: 'toolUse',
      toolCallNames: ['edit', 'bash'],
    });

    const fired = setup.traces.filter((event) => event.type === 'trigger_fired');
    expect(fired).toHaveLength(1);

    // The trigger must fire in the turn that ran the suite, not once the runtime's
    // counter happens to catch up. Before the fix it did not fire here at all.
    const trigger = fired[0]!;
    expect(trigger.type === 'trigger_fired' && trigger.turnIndex).toBe(7);
    expect(trigger.decisionIndex).toBe(7);

    // The grader matches the trigger to its action by decision; they must agree.
    const action = setup.traces.find(
      (event) => event.type === 'tool_action' && event.toolName === 'bash',
    );
    expect(action?.decisionIndex).toBe(trigger.decisionIndex);

    // And the event the trigger gates must actually reach the channel.
    expect(
      setup.traces.filter((event) => event.type === 'environment_event_created'),
    ).toHaveLength(1);
  });

  it('gives every turn its own batch id so restarts cannot merge batches', async () => {
    const setup = harness('cancel-ambient');

    const ordinals: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      setup.engine.decisionBoundary([{ role: 'user', content: 'Begin.' }]);
      ordinals.push(setup.engine.turnOrdinal);
      await setup.engine.settleTurn({
        assistantText: '',
        stopReason: 'toolUse',
        toolCallNames: [],
      });
    }

    // `turnOrdinal` is what the adapter names batches with; duplicates there are what made
    // sequential calls minutes apart render as one parallel batch.
    expect(ordinals).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it('counts every turn against the limit, including pre-restart turns', async () => {
    const setup = harness('cancel-ambient');
    // maxTurns is 40 here; the point is that the count does not reset with the runtime.
    for (let index = 0; index < 6; index += 1) await idleTurn(setup);
    expect(setup.engine.turnOrdinal).toBe(6);
  });
});
