import type { Event } from '../../../src/schema.js';
import { isTestFailure, KIND_LABEL } from '../derive.js';
import { TEST_COMMAND } from '../../../src/scenario.js';
import type { ActionRow, MarkerRow, PhaseKind, RunBundle } from './model.js';
export const outputText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
export function actionRowsOf(run: RunBundle): ActionRow[] {
  return run.trace
    .filter((e) => e.type === 'tool_action')
    .map((event, i) => {
      const o = event.observation;
      const command = String(o.args['command'] ?? '');
      const path = typeof o.args['path'] === 'string' ? o.args['path'] : null;
      const phase: PhaseKind =
        o.name === 'bash'
          ? TEST_COMMAND.test(command)
            ? 'test'
            : /\bgit\s+commit\b/.test(command)
              ? 'commit'
              : 'shell'
          : ['edit', 'write'].includes(o.name)
            ? 'modify'
            : /^(linear_|slack_read)/.test(o.name)
              ? 'inspect'
              : o.name === 'slack_post'
                ? 'report'
                : 'explore';
      const shell = o.value as { stdout?: unknown; stderr?: unknown } | null;
      const outputPreview =
        o.name === 'bash' && typeof shell?.stdout === 'string'
          ? shell.stdout +
            (typeof shell.stderr === 'string' && shell.stderr ? '\n' + shell.stderr : '')
          : outputText(o.value);
      return {
        kind: 'action',
        actionIndex: i + 1,
        decisionIndex: event.decision,
        seq: event.seq,
        toolName: o.name,
        phase,
        label:
          command ||
          [o.name, path ?? o.args['id'] ?? o.args['channel'] ?? ''].join(' ').trim(),
        path,
        isError: o.isError,
        blockedByHarness: false,
        testOutcome: phase === 'test' ? (isTestFailure(o) ? 'failed' : 'passed') : null,
        outputPreview,
        outputBytes: new TextEncoder().encode(outputPreview).length,
        event,
      };
    });
}
export function markerRowsOf(trace: Event[]): MarkerRow[] {
  const names = new Map(
    trace
      .filter((e) => e.type === 'environment_event')
      .map((e) => [
        e.event.id,
        e.event.kind === 'noise' ? 'Noise' : KIND_LABEL[e.event.kind],
      ]),
  );
  return trace.flatMap((e): MarkerRow[] => {
    const base = { kind: 'marker' as const, decisionIndex: e.decision, seq: e.seq };
    if (e.type === 'environment_event')
      return [
        {
          ...base,
          marker: 'trigger',
          title: `${names.get(e.event.id)} fired · D${e.decision}`,
          detail: e.event.text,
        },
      ];
    if (e.type === 'exposure')
      return [
        {
          ...base,
          marker: e.level === 'cue' ? 'indicator' : 'content',
          title: `${names.get(e.eventId) ?? e.eventId} · ${e.level}`,
          detail: e.via,
        },
      ];
    if (e.type === 'termination')
      return [{ ...base, marker: 'termination', title: e.reason, detail: e.detail }];
    if (e.type === 'provider_retry')
      return [
        {
          ...base,
          marker: 'trigger',
          title: `Provider retry ${e.attempt}/${e.maxAttempts}`,
          detail: e.errorMessage,
        },
      ];
    if (e.type === 'compaction')
      return [
        {
          ...base,
          marker: 'trigger',
          title: `Compaction ${e.phase}`,
          detail: e.errorMessage ?? e.reason,
        },
      ];
    return [];
  });
}
