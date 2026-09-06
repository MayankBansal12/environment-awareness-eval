/**
 * Turning tool actions into something readable.
 *
 * `assistant_turn.text` is empty on every tool-using turn, so there is no narration to
 * show. The activity view is therefore derived entirely from tool actions: what tool ran,
 * against what path, with what observed outcome.
 */

import { classifyTestOutcome } from '../../../src/engine/triggers.js';
import { COMMIT_PATTERN, TEST_PATTERN } from '../../../src/grading/grader.js';
import type { TraceEvent } from '../../../src/trace/schema.js';
import type { ActionRow, PhaseKind, TestOutcomeLabel } from './model.js';
import { stripWorkspacePrefix } from './paths.js';

type ToolAction = Extract<TraceEvent, { type: 'tool_action' }>;

/**
 * Classifies a `bash` command exactly as the grader does, using the grader's own exported
 * regexes. The grader tests for a commit first when counting commit attempts, so a
 * combined `pnpm test && git commit` is a commit attempt in its metrics — commit wins here
 * too, and the label can never disagree with the grade shown beside it.
 */
export function classifyBash(command: string): PhaseKind {
  if (COMMIT_PATTERN.test(command)) return 'commit';
  if (TEST_PATTERN.test(command)) return 'test';
  return 'shell';
}

/** Phase label for a tool action. `bash` needs the command to disambiguate. */
export function phaseForAction(
  toolName: string,
  inputSummary: Record<string, unknown>,
): PhaseKind {
  switch (toolName) {
    case 'read':
    case 'ls':
    case 'find':
    case 'grep':
      return 'explore';
    case 'edit':
    case 'write':
      return 'modify';
    case 'read_slack_messages':
      return 'inspect';
    case 'post_slack_message':
      return 'report';
    case 'bash': {
      const command = inputSummary['command'];
      return typeof command === 'string' ? classifyBash(command) : 'shell';
    }
    default:
      return 'shell';
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * The primary path an action targeted, workspace-prefix stripped.
 * `bash` and the Slack tools have no path.
 */
export function actionPath(
  action: Pick<ToolAction, 'toolName' | 'inputSummary'>,
  workspacePath: string | null,
): string | null {
  const raw = asString(action.inputSummary['path']);
  if (raw === null) return null;
  return stripWorkspacePrefix(raw, workspacePath);
}

/**
 * A one-line rendering of the action, built from `inputSummary` only. The shapes present
 * across the corpus are `read/ls :: path`, `edit :: path,editCount`,
 * `write :: path,contentBytes`, `find/grep :: path,pattern` (grep sometimes `pattern`
 * alone), `bash :: command`, `post_slack_message :: text` and `read_slack_messages :: {}`.
 */
export function actionLabel(
  action: Pick<ToolAction, 'toolName' | 'inputSummary'>,
  workspacePath: string | null,
): { label: string; detail: string | null } {
  const summary = action.inputSummary;
  const path = actionPath(action, workspacePath);
  const pattern = asString(summary['pattern']);

  switch (action.toolName) {
    case 'read':
    case 'ls':
      return { label: `${action.toolName} ${path ?? ''}`.trim(), detail: null };
    case 'edit': {
      const edits = asNumber(summary['editCount']);
      return {
        label: `edit ${path ?? ''}`.trim(),
        detail: edits === null ? null : `${edits} edit${edits === 1 ? '' : 's'}`,
      };
    }
    case 'write': {
      const bytes = asNumber(summary['contentBytes']);
      return {
        label: `write ${path ?? ''}`.trim(),
        detail: bytes === null ? null : `${bytes} B`,
      };
    }
    case 'find':
    case 'grep': {
      const scope = [path, pattern === null ? null : `/${pattern}/`]
        .filter((part): part is string => part !== null)
        .join(' ');
      return { label: `${action.toolName} ${scope}`.trim(), detail: null };
    }
    case 'bash': {
      const command = asString(summary['command']);
      return { label: command === null ? 'bash' : `bash ${command}`, detail: null };
    }
    case 'post_slack_message': {
      const text = asString(summary['text']);
      return { label: 'post_slack_message', detail: text };
    }
    case 'read_slack_messages':
      return { label: 'read_slack_messages', detail: null };
    default: {
      const keys = Object.keys(summary);
      return {
        label: action.toolName,
        detail: keys.length === 0 ? null : keys.join(', '),
      };
    }
  }
}

/**
 * The observed test outcome for an action.
 *
 * `observedTestOutcome` is optional and is recorded for most, but not all, test commands —
 * the oldest runs in the corpus omit it entirely. The recorded value wins when present;
 * otherwise the grader's own fallback, `classifyTestOutcome(isError, outputPreview)`, is
 * applied. This is exactly the precedence `grader.ts` uses, so the ✓/✗ in the timeline
 * cannot disagree with the grade in the header.
 */
export function testOutcomeFor(
  action: Pick<
    ToolAction,
    'toolName' | 'isError' | 'outputPreview' | 'observedTestOutcome'
  >,
  phase: PhaseKind,
): TestOutcomeLabel | null {
  if (action.observedTestOutcome !== undefined) return action.observedTestOutcome;
  if (phase !== 'test') return null;
  return classifyTestOutcome(action.isError, action.outputPreview);
}

/** Builds the full derived row for one `tool_action` event. */
export function toActionRow(
  action: ToolAction,
  workspacePath: string | null,
  batchSizes: Map<string, number>,
): ActionRow {
  const phase = phaseForAction(action.toolName, action.inputSummary);
  const { label, detail } = actionLabel(action, workspacePath);
  const batchId = action.batchId ?? null;
  return {
    kind: 'action',
    actionIndex: action.actionIndex,
    decisionIndex: action.decisionIndex,
    seq: action.seq,
    toolName: action.toolName,
    phase,
    label,
    path: actionPath(action, workspacePath),
    detail,
    isError: action.isError,
    blockedByHarness: action.blockedByHarness,
    testOutcome: testOutcomeFor(action, phase),
    batchId,
    siblingOrdinal: action.siblingOrdinal ?? null,
    inParallelBatch: batchId !== null && (batchSizes.get(batchId) ?? 0) > 1,
    outputPreview: action.outputPreview,
    outputBytes: action.outputBytes,
    event: action,
  };
}

export const PHASE_GLYPH: Record<PhaseKind, string> = {
  explore: '▸',
  modify: '●',
  inspect: '◆',
  report: '✉',
  test: '▶',
  commit: '⎇',
  shell: '›',
};
