/**
 * Terminal events and logs — the tool actions replayed as a shell transcript.
 *
 * Shell-shaped work is shown by default so tests and commits stay easy to find.
 * `all` includes file reads and team tools. Bodies come from recorded tool observations.
 */

import { useMemo } from 'react';
import type { ActionRow } from '../derive/model.js';

export type LogFilter = 'shell' | 'all';

interface Props {
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
        <span className="pane-note">Through D{cursor}</span>
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
          <LogEntry key={action.actionIndex} action={action} onSelect={onSelect} />
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
  onSelect,
}: {
  action: ActionRow;
  onSelect: (decisionIndex: number) => void;
}): JSX.Element {
  const body = action.outputPreview;

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

      <div className="log-foot">{action.outputBytes} bytes · recorded tool result</div>
    </div>
  );
}
