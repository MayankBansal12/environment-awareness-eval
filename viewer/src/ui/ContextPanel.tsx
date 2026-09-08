/**
 * “What was in context at D<n>” — read straight off the `decision_boundary` event for
 * that decision. This is the ground truth for what the model could perceive at that
 * moment; nothing here is reconstructed or inferred.
 */

import { useState } from 'react';
import type { TraceEvent } from '../../../src/trace/schema.js';
import type { ActionRow, MarkerRow, RunBundle } from '../derive/model.js';
import { stripWorkspacePrefixEverywhere } from '../derive/paths.js';
import { describeTruncation, truncationOfAction } from '../derive/truncation.js';

type Boundary = Extract<TraceEvent, { type: 'decision_boundary' }>;

type Tab = 'status' | 'events' | 'io' | 'raw';

/**
 * What the panel is describing. The timeline selects a concrete row; the cockpit only has
 * a cursor, and a bare decision is a complete answer to "what was in context" on its own —
 * the status and event blocks are properties of the decision, not of any row inside it.
 */
export type ContextSelection =
  | ActionRow
  | MarkerRow
  | { kind: 'decision'; decisionIndex: number };

interface Props {
  run: RunBundle;
  selected: ContextSelection | null;
}

export function ContextPanel({ run, selected }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('status');

  if (selected === null) {
    return (
      <div className="panel">
        <h3>what was in context</h3>
        <pre className="block empty">
          Select any timeline row to see the exact status block, event blocks and tool
          output that were present at that decision.
        </pre>
      </div>
    );
  }

  const decisionIndex = selected.decisionIndex;
  const boundary = run.trace.find(
    (event): event is Boundary =>
      event.type === 'decision_boundary' && event.decisionIndex === decisionIndex,
  );

  return (
    <div className="panel">
      <h3>
        D{decisionIndex} · what was in context
      </h3>
      <div className="tabs">
        <TabButton id="status" tab={tab} setTab={setTab} label="status block" />
        <TabButton id="events" tab={tab} setTab={setTab} label="event blocks" />
        <TabButton id="io" tab={tab} setTab={setTab} label="tool i/o" />
        <TabButton id="raw" tab={tab} setTab={setTab} label="raw json" />
      </div>

      {boundary === undefined ? (
        <pre className="block empty">
          No decision_boundary event recorded for D{decisionIndex}. Events before the first
          model call carry decisionIndex -1.
        </pre>
      ) : (
        <>
          {tab === 'status' && (
            <pre className="block">
              {boundary.statusBlock ?? '(no environment_status block in this call)'}
            </pre>
          )}

          {tab === 'events' && (
            <pre className="block">
              {boundary.eventBlocks.length === 0
                ? '(no environment_event block in this call)'
                : boundary.eventBlocks
                    .map(
                      (block) =>
                        `# ${block.slackMessageId} anchored to ${block.anchor}\n${block.block}`,
                    )
                    .join('\n\n')}
            </pre>
          )}

          {tab === 'io' && <ToolIo run={run} selected={selected} />}

          {tab === 'raw' && (
            <pre className="block">{JSON.stringify(boundary, null, 2)}</pre>
          )}

          <div className="facts">
            <div>anchored to: {boundary.statusAnchor}</div>
            <div>
              authoritative content present:{' '}
              {boundary.authoritativeContentMessageIds.length === 0
                ? 'none'
                : boundary.authoritativeContentMessageIds.join(', ')}
            </div>
            <div>
              slack: {boundary.slackUnread} unread, {boundary.slackMentions} mention
              {boundary.slackMentions === 1 ? '' : 's'}
            </div>
            <div>context messages: {boundary.contextMessageCount}</div>
          </div>
        </>
      )}
    </div>
  );
}

function ToolIo({ run, selected }: Props): JSX.Element {
  if (selected === null || selected.kind !== 'action') {
    return <pre className="block empty">Select a tool action to see its input and output.</pre>;
  }
  const truncation = truncationOfAction(
    selected.event.type === 'tool_action' ? selected.event : selected,
  );
  return (
    <>
      <pre className="block">
        {`$ ${selected.label}\n\n`}
        {stripWorkspacePrefixEverywhere(selected.outputPreview, run.workspacePath)}
      </pre>
      <div className="facts">
        <div>
          {selected.outputBytes} bytes
          {truncation.truncated && ` · ${describeTruncation(truncation)}`}
        </div>
        <div>tool call id: {selected.event.type === 'tool_action' ? selected.event.toolCallId : ''}</div>
        {selected.inParallelBatch && (
          <div>
            issued in parallel batch {selected.batchId} (sibling #{selected.siblingOrdinal})
          </div>
        )}
      </div>
    </>
  );
}

function TabButton({
  id,
  tab,
  setTab,
  label,
}: {
  id: Tab;
  tab: Tab;
  setTab: (tab: Tab) => void;
  label: string;
}): JSX.Element {
  return (
    <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
      {label}
    </button>
  );
}
