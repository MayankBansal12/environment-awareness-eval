/**
 * Terminal events and logs — the tool actions replayed as a shell transcript.
 *
 * Filtered to shell-shaped work by default. A run issues ~25 `read`/`ls` calls whose
 * output is file content already visible in the activity pane and the diff; replaying it
 * here would bury the handful of `pnpm test` and `git commit` invocations that actually
 * decide the grade. `all` is one click away for when the file reads matter.
 *
 * Output is `outputPreview`, which the trace writer caps at `MAX_TOOL_OUTPUT_PREVIEW`
 * characters. Where it hit that cap the row says so, so a truncated log is never mistaken
 * for a short one.
 */

import { useMemo } from 'react';
import type { ActionRow, RunBundle } from '../derive/model.js';
import { stripWorkspacePrefixEverywhere } from '../derive/paths.js';
import { describeTruncation, truncationOfAction } from '../derive/truncation.js';

export type LogFilter = 'shell' | 'all';

interface Props {
  run: RunBundle;
  actions: readonly ActionRow[];
  cursor: number;
  filter: LogFilter;
  onFilterChange: (filter: LogFilter) => void;
  onSelect: (decisionIndex: number) => void;
}

/** `bash` and its classifications, plus anything the harness refused. */
function isShellShaped(action: ActionRow): boolean {
  return (
    action.toolName === 'bash' ||
    action.phase === 'test' ||
    action.phase === 'commit' ||
    action.phase === 'shell' ||
    action.blockedByHarness
  );
}

export function TerminalPane({
  run,
  actions,
  cursor,
  filter,
  onFilterChange,
  onSelect,
}: Props): JSX.Element {
  const shown = useMemo(
    () =>
      actions.filter(
        (action) =>
          action.decisionIndex <= cursor && (filter === 'all' || isShellShaped(action)),
      ),
    [actions, cursor, filter],
  );

  const hiddenAhead = actions.filter((action) => action.decisionIndex > cursor).length;

  return (
    <section className="pane terminalpane">
      <h3>
        Terminal & tool logs
        <span className="pane-note">through D{cursor}</span>
        <span className="spacer" />
        <span className="nav">
          {(['shell', 'all'] as const).map((level) => (
            <button
              key={level}
              className={filter === level ? 'active' : ''}
              onClick={() => onFilterChange(level)}
            >
              {level}
            </button>
          ))}
        </span>
      </h3>

      <div className="pane-body term">
        {shown.length === 0 && (
          <p className="empty-note">
            No {filter === 'shell' ? 'shell' : ''} commands run at or before D{cursor}.
          </p>
        )}

        {shown.map((action) => (
          <LogEntry
            key={action.actionIndex}
            action={action}
            workspacePath={run.workspacePath}
            onSelect={onSelect}
          />
        ))}

        {hiddenAhead > 0 && (
          <p className="empty-note">
            {hiddenAhead} later action{hiddenAhead === 1 ? '' : 's'} after D{cursor} — scrub
            forward to include them.
          </p>
        )}
      </div>
    </section>
  );
}

function LogEntry({
  action,
  workspacePath,
  onSelect,
}: {
  action: ActionRow;
  workspacePath: string | null;
  onSelect: (decisionIndex: number) => void;
}): JSX.Element {
  const truncation = truncationOfAction(
    action.event.type === 'tool_action' ? action.event : action,
  );
  const body = stripWorkspacePrefixEverywhere(action.outputPreview, workspacePath);

  return (
    <div className="logentry" onClick={() => onSelect(action.decisionIndex)}>
      <div className="log-cmd">
        <span className="tl-d">D{action.decisionIndex}</span>
        <span className="prompt">$</span>
        <span className={`cmd ${action.phase}`}>{action.label}</span>
        {action.blockedByHarness && <span className="err"> BLOCKED BY HARNESS</span>}
        {action.isError && !action.blockedByHarness && <span className="err"> error</span>}
        {action.testOutcome !== null && (
          <span className={`outcome ${action.testOutcome}`}>
            {action.testOutcome === 'passed'
              ? ' ✓ passed'
              : action.testOutcome === 'failed'
                ? ' ✗ failed'
                : ' ? unknown'}
          </span>
        )}
      </div>

      {body.trim() !== '' && <pre className="log-out">{body}</pre>}

      <div className="log-foot">
        {action.outputBytes} bytes
        {truncation.truncated && ` · ${describeTruncation(truncation)}`}
        {action.inParallelBatch && ` · parallel batch ${action.batchId ?? ''}`}
      </div>
    </div>
  );
}
