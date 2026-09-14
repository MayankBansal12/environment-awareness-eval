import { useState } from 'react';
import type { CapturedBlock, CapturedMessage } from '../../../src/harness/capture.js';
import { inputMessages, isTestFailure, KIND_LABEL, type DecisionRow } from '../derive.js';
import { tokens, usd } from '../format.js';
import type { RunDetail } from '../model.js';

type Tab = 'io' | 'system';

export function Inspector({
  run,
  rows,
  decision,
  onSelect,
}: {
  run: RunDetail;
  rows: DecisionRow[];
  decision: number;
  onSelect: (d: number) => void;
}) {
  const [tab, setTab] = useState<Tab>('io');
  const row = rows[decision - 1];
  const inputs = inputMessages(run, decision);
  const earlier = inputs.filter((m) => !m.isNew);
  const output = run.outputs[decision];

  return (
    <div className="card inspector">
      <div className="inspector-head">
        <h2>Model call D{decision}</h2>
        <button disabled={decision <= 1} onClick={() => onSelect(decision - 1)}>
          ← prev
        </button>
        <button disabled={decision >= rows.length} onClick={() => onSelect(decision + 1)}>
          next →
        </button>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'io'} onClick={() => setTab('io')}>
            Input &amp; output
          </button>
          <button
            role="tab"
            aria-selected={tab === 'system'}
            onClick={() => setTab('system')}
          >
            System &amp; tools
          </button>
        </div>
        {row && (
          <span className="small muted">
            {row.stopReason} · {tokens(row.tokens)} tokens · {usd(row.costUsd)} · unread
            Linear {row.unread.linear} / Slack {row.unread.slack}
          </span>
        )}
      </div>
      {run.capture && !run.capture.complete && (
        <p className="warning small">
          Capture incomplete: {run.capture.inputs} inputs, {run.capture.outputs} outputs.
        </p>
      )}
      {tab === 'system' ? (
        <SystemTab run={run} />
      ) : (
        <div className="io">
          <div>
            <h3>Input</h3>
            {!inputs.length && <p className="muted">Not captured.</p>}
            {earlier.length > 0 && (
              <details>
                <summary>
                  {earlier.length} message{earlier.length === 1 ? '' : 's'} unchanged since
                  D{decision - 1}
                </summary>
                {earlier.map((m, i) => (
                  <Message key={i} message={m.message} />
                ))}
              </details>
            )}
            {inputs
              .filter((m) => m.isNew)
              .map((m, i) => (
                <Message key={i} message={m.message} />
              ))}
          </div>
          <div>
            <h3>Output</h3>
            {output ? <Message message={output} /> : <p className="muted">Not captured.</p>}
            {row && row.actions.length > 0 && (
              <>
                <h3>Tool results</h3>
                {row.actions.map((a) => (
                  <div
                    key={a.id}
                    className={`message tool${a.isError || isTestFailure(a) ? ' failed' : ''}`}
                  >
                    <div className="role">
                      {a.name} <span className="muted">{a.id}</span>
                    </div>
                    <pre>
                      {typeof a.value === 'string'
                        ? a.value
                        : JSON.stringify(a.value, null, 2)}
                    </pre>
                  </div>
                ))}
              </>
            )}
            {row && (row.fired.length > 0 || row.exposures.length > 0) && (
              <>
                <h3>Environment at this boundary</h3>
                {row.exposures.map((e) => (
                  <div key={e.eventId + e.level} className="small">
                    <span className={`swatch fill-${e.kind}`} /> {KIND_LABEL[e.kind]}:{' '}
                    {e.level} via {e.via}
                  </div>
                ))}
                {row.fired.map((f) => (
                  <div
                    key={f.eventId}
                    className={`message ${f.kind === 'noise' ? 'noise-msg' : 'update'}`}
                  >
                    <div className="role">
                      {f.kind === 'noise' ? 'noise' : KIND_LABEL[f.kind]} · fired after this
                      decision · {f.trigger}
                    </div>
                    <pre>{f.text}</pre>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SystemTab({ run }: { run: RunDetail }) {
  if (!run.header) return <p className="muted">No context header captured.</p>;
  return (
    <div>
      <h3>System prompt</h3>
      <pre className="prompt">{run.header.systemPrompt}</pre>
      <h3>Tools ({run.header.tools.length})</h3>
      {run.header.tools.map((t) => (
        <details key={t.name} className="tool-def">
          <summary>
            <code>{t.name}</code> <span className="muted">{t.description}</span>
          </summary>
          <pre>{JSON.stringify(t.parameters, null, 2)}</pre>
        </details>
      ))}
      <details>
        <summary>Runtime identity</summary>
        <pre>{JSON.stringify(run.header.runtime, null, 2)}</pre>
      </details>
    </div>
  );
}

const MARKUP =
  /(<environment_status>[\s\S]*?<\/environment_status>|<notification>[\s\S]*?<\/notification>)/g;

function Text({ text }: { text: string }) {
  return (
    <pre>
      {text.split(MARKUP).map((part, i) =>
        i % 2 ? (
          <mark
            key={i}
            className={part.startsWith('<notification>') ? 'notification' : 'status-block'}
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </pre>
  );
}

function Block({ block }: { block: CapturedBlock }) {
  if (block.kind === 'text') return <Text text={block.text} />;
  if (block.kind === 'thinking')
    return (
      <div className="thinking">
        <span className="muted small">
          thinking{block.providerRedacted ? ' (redacted by provider)' : ''}
        </span>
        <pre>{block.text}</pre>
      </div>
    );
  if (block.kind === 'toolCall')
    return (
      <div className="tool-call">
        <code>{block.name}</code> <span className="muted small">{block.id}</span>
        <pre>{JSON.stringify(block.arguments, null, 2)}</pre>
      </div>
    );
  if (block.kind === 'image')
    return <p className="muted small">[image {block.mimeType}, payload omitted]</p>;
  return (
    <p className="muted small">
      [{block.blockType}: {block.note}]
    </p>
  );
}

function Message({ message }: { message: CapturedMessage }) {
  return (
    <div className={`message role-${message.role}`}>
      <div className="role">
        {message.role}
        {message.toolName ? ` · ${message.toolName}` : ''}
        {message.toolCallId ? <span className="muted"> {message.toolCallId}</span> : null}
        {message.truncated && <span className="warning"> truncated</span>}
        {message.redacted && <span className="warning"> redacted</span>}
      </div>
      {message.blocks ? (
        message.blocks.map((b, i) => <Block key={i} block={b} />)
      ) : (
        <Text text={message.text} />
      )}
    </div>
  );
}
