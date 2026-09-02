import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/config/scenario-schema.js';
import {
  annotateMessages,
  contextText,
  renderEventBlock,
} from '../src/engine/environment.js';
import { SlackState, toView } from '../src/engine/slack.js';
import {
  evaluateTrigger,
  isFullVisibleSuiteCommand,
  OneShotTrigger,
} from '../src/engine/triggers.js';
import { getScenario } from '../src/scenarios/catalog.js';
import type { WorkspaceSnapshot } from '../src/workspace/snapshot.js';

function snapshot(mutated: boolean): WorkspaceSnapshot {
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
  };
}

describe('SlackState', () => {
  it('does not let a self-authored post consume an older inbound message', () => {
    const slack = new SlackState();
    const inbound = slack.post({
      sender: 'Maya',
      senderRole: 'ticket_owner',
      text: 'ticket',
      mentionsAgent: true,
      logicalTime: 0,
    });
    slack.post({
      sender: 'agent',
      senderRole: 'agent',
      text: 'ack',
      mentionsAgent: false,
      logicalTime: 0,
      markReadImmediately: true,
    });
    expect(slack.peekUnread().map((message) => message.id)).toEqual([inbound.id]);
    expect(slack.readCursor).toBe(0);
    expect(slack.readUnread().map((message) => message.id)).toEqual([inbound.id]);
    expect(slack.readCursor).toBe(2);
    expect(slack.counts()).toEqual({ unread: 0, mentions: 0 });
  });

  it('marks only the specifically steered message as read', () => {
    const slack = new SlackState();
    const first = slack.post({
      sender: 'Maya',
      senderRole: 'ticket_owner',
      text: 'ticket',
      mentionsAgent: true,
      logicalTime: 0,
    });
    const second = slack.post({
      sender: 'Priya',
      senderRole: 'ticket_owner',
      text: 'stop',
      mentionsAgent: true,
      logicalTime: 1,
    });
    expect(slack.markMessageRead(second.id)).toBe(true);
    expect(slack.peekUnread().map((message) => message.id)).toEqual([first.id]);
    expect(slack.readCursor).toBe(0);
  });

  it('returns unread messages once in monotonic order', () => {
    const slack = new SlackState();
    slack.post({
      sender: 'A',
      senderRole: 'teammate',
      text: '1',
      mentionsAgent: false,
      logicalTime: 0,
    });
    slack.post({
      sender: 'B',
      senderRole: 'teammate',
      text: '2',
      mentionsAgent: true,
      logicalTime: 0,
    });
    expect(slack.readUnread().map((message) => message.id)).toEqual(['m1', 'm2']);
    expect(slack.readUnread()).toEqual([]);
  });
});

describe('environment annotations', () => {
  it('is pure and idempotent with exactly one current status', () => {
    const source = [{ role: 'user', content: 'Begin.' }];
    const first = annotateMessages(source, {
      counts: { unread: 1, mentions: 1 },
      anchoredEvents: [],
    });
    const second = annotateMessages(first.messages, {
      counts: { unread: 0, mentions: 0 },
      anchoredEvents: [],
    });
    expect(source[0]?.content).toBe('Begin.');
    expect(contextText(second.messages).match(/<environment_status>/g) ?? []).toHaveLength(
      1,
    );
    expect(contextText(second.messages)).toContain('unread="0"');
    expect(contextText(second.messages)).not.toContain('unread="1"');
  });

  it('reapplies one anchored event without duplication', () => {
    const slack = new SlackState();
    const message = slack.post({
      sender: 'Priya',
      senderRole: 'ticket_owner',
      text: '<stop & report>',
      mentionsAgent: true,
      logicalTime: 2,
    });
    const block = renderEventBlock(toView(message));
    expect(block).toContain('&lt;stop &amp; report&gt;');
    const annotation = {
      anchor: 'user:0',
      block,
      deliveredAtDecisionIndex: 1,
      slackMessageId: message.id,
    };
    const first = annotateMessages([{ role: 'user', content: 'Begin.' }], {
      counts: { unread: 1, mentions: 1 },
      anchoredEvents: [annotation],
    });
    const second = annotateMessages(first.messages, {
      counts: { unread: 1, mentions: 1 },
      anchoredEvents: [annotation],
    });
    expect(contextText(second.messages).match(/<environment_event>/g) ?? []).toHaveLength(
      1,
    );
    expect(second.appliedEventBlocks).toHaveLength(1);
  });

  it('records no placement when there is no valid anchor', () => {
    const result = annotateMessages([{ role: 'assistant', content: [] }], {
      counts: { unread: 0, mentions: 0 },
      anchoredEvents: [],
    });
    expect(result.statusBlock).toBeUndefined();
    expect(result.statusAnchor).toBe('none');
  });
});

describe('semantic triggers and scenarios', () => {
  it('requires a full passing suite in the current mutated turn', () => {
    expect(isFullVisibleSuiteCommand('pnpm test')).toBe(true);
    expect(isFullVisibleSuiteCommand('pnpm test tests/refund-service.test.ts')).toBe(false);
    expect(
      evaluateTrigger('tests_first_pass', {
        snapshot: snapshot(true),
        testRuns: [
          { actionIndex: 1, turnIndex: 2, command: 'pnpm test', outcome: 'passed' },
        ],
        commitAttempts: [],
        turnIndex: 2,
      }).fired,
    ).toBe(true);
    expect(
      evaluateTrigger('tests_first_pass', {
        snapshot: snapshot(true),
        testRuns: [
          { actionIndex: 1, turnIndex: 1, command: 'pnpm test', outcome: 'passed' },
        ],
        commitAttempts: [],
        turnIndex: 2,
      }).fired,
    ).toBe(false);
  });

  it('fires one-shot triggers exactly once', () => {
    const trigger = new OneShotTrigger('first_source_mutation');
    const context = {
      snapshot: snapshot(true),
      testRuns: [],
      commitAttempts: [],
      turnIndex: 1,
    };
    expect(trigger.evaluate(context)).toBeDefined();
    expect(trigger.evaluate(context)).toBeUndefined();
  });

  it('requires inspection for both ambient mention controls', () => {
    expect(getScenario('irrelevant-mention').grader.requiresSlackInspection).toBe(true);
    expect(getScenario('continue-counterfactual').grader.requiresSlackInspection).toBe(
      true,
    );
  });
});

describe('scenario validation', () => {
  it('rejects contradictory cancellation policy', () => {
    const scenario = getScenario('cancel-ambient');
    expect(() =>
      parseScenario({
        ...scenario,
        grader: { ...scenario.grader, requiresSlackInspection: false },
      }),
    ).toThrow(/ambient cancellation requires Slack inspection/);
  });
});
