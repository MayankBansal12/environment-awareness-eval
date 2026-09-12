import { useState } from 'react';
import type { V2Bundle, V2Event } from '../../../src/v2/schema.js';

export function V2Runs({
  runs,
  initialRunId = null,
}: {
  runs: V2Bundle[];
  initialRunId?: string | null;
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(initialRunId);
  const [decision, setDecision] = useState<number | null>(null);
  const run = runs.find((r) => r.summary.runId === selected);
  if (!run)
    return (
      <section>
        <header className="page-heading">
          <div>
            <h2>Linear + Slack evaluations</h2>
            <p>
              Task demand, retrieved ticket state, and behavior after environmental changes.
            </p>
          </div>
          <span>{runs.length} runs</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Task demand</th>
              <th>Phase / fixture</th>
              <th>Condition</th>
              <th>Validity</th>
              <th>Behavior</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.summary.runId}>
                <td>
                  <button
                    onClick={() => {
                      setSelected(r.summary.runId);
                      setDecision(null);
                    }}
                  >
                    {r.summary.runId}
                  </button>
                </td>
                <td>{r.summary.demand}</td>
                <td>
                  {r.summary.experiment?.phase ?? 'development'} /{' '}
                  {String(r.summary.runtime.fixtureVersion ?? 'original smoke')}
                </td>
                <td>{r.summary.condition}</td>
                <td>{r.summary.grade.valid ? 'Valid' : 'Invalid'}</td>
                <td>{r.summary.grade.classification.replaceAll('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  const { summary, trace, context } = run;
  const inputs = context.filter((c) => c.type === 'input');
  const d = decision ?? inputs.at(-1)?.decision ?? 0;
  const input = inputs.find((c) => c.decision === d);
  const output = context.find((c) => c.type === 'output' && c.decision === d);
  const events = trace.filter((e) => e.decision === d);
  return (
    <section>
      <button onClick={() => setSelected(null)}>← All Linear + Slack runs</button>
      <header className="page-heading">
        <div>
          <h2>{summary.runId}</h2>
          <p>
            {summary.demand} demand · {summary.condition} · {String(summary.runtime.model)}
          </p>
        </div>
        <strong>{summary.grade.classification.replaceAll('_', ' ')}</strong>
      </header>
      <p>
        Valid: {String(summary.grade.valid)} · Termination: {summary.termination.reason} ·
        Captured decisions: {summary.capture.inputs}/{summary.capture.outputs} ·{' '}
        {summary.capture.complete ? 'Complete records' : 'Incomplete records'}
        {summary.capture.partialContent ? ' · Partial content' : ''}
      </p>
      <div className="v2-grid">
        <div className="card">
          <h3>Final ticket state</h3>
          <pre>{JSON.stringify(summary.finalTicket, null, 2)}</pre>
        </div>
        <div className="card">
          <h3>Behavior and opportunity</h3>
          <pre>{JSON.stringify(summary.grade.metrics, null, 2)}</pre>
        </div>
      </div>
      <details>
        <summary>Validity, outcomes, and diagnostic functional checks</summary>
        <pre>
          {JSON.stringify(
            {
              validity: summary.grade.validity,
              outcomes: summary.grade.outcomes,
              hiddenChecks: summary.hiddenChecks,
              checkpointChecks: summary.checkpointChecks,
              independentAudit: summary.audit,
            },
            null,
            2,
          )}
        </pre>
        <p>
          Functional completion is not required after cancellation. Failed provider attempts
          are separate from behavioral failures.
        </p>
      </details>
      <h3>Decision timeline</h3>
      <div className="v2-decisions">
        {inputs.map((i) => (
          <button
            key={i.decision}
            className={i.decision === d ? 'active' : ''}
            onClick={() => setDecision(i.decision)}
          >
            D{i.decision}
          </button>
        ))}
      </div>
      <p>
        Event records use the decision that preceded a boundary change. Exposure is recorded
        on the next decision that actually receives the information.
      </p>
      <table>
        <thead>
          <tr>
            <th>Sequence</th>
            <th>Event</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.seq}>
              <td>{e.seq}</td>
              <td>{label(e)}</td>
              <td>
                <details>
                  <summary>{detail(e)}</summary>
                  <pre>{JSON.stringify(e, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="v2-grid">
        <div>
          <h3>Input to D{d}</h3>
          {input?.messages.map((m, i) => (
            <details key={i} open={i >= input.messages.length - 2}>
              <summary>
                {m.role}
                {m.toolName ? ' · ' + m.toolName : ''}
                {m.truncated ? ' · truncated' : ''}
                {m.omitted ? ' · omitted content' : ''}
              </summary>
              <pre>{JSON.stringify(m.blocks ?? m.text, null, 2)}</pre>
            </details>
          ))}
        </div>
        <div>
          <h3>Assistant output</h3>
          {output?.type === 'output' && (
            <pre>
              {JSON.stringify(output.message.blocks ?? output.message.text, null, 2)}
            </pre>
          )}
        </div>
      </div>
      <details>
        <summary>System prompt and tool schemas</summary>
        <pre>
          {JSON.stringify(
            context.find((c) => c.type === 'header'),
            null,
            2,
          )}
        </pre>
      </details>
      <details>
        <summary>Artifacts and runtime identity</summary>
        <pre>
          {JSON.stringify(
            { artifacts: summary.artifacts, runtime: summary.runtime },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
function label(e: V2Event): string {
  return e.type.replaceAll('_', ' ');
}
function detail(e: V2Event): string {
  if (e.type === 'tool_action') return `${e.name}${e.isError ? ' · error' : ''}`;
  if (e.type === 'exposure') return `${e.kind} via ${e.source}`;
  if (e.type === 'ticket_changed')
    return `${e.before.status} → ${e.after.status}${e.slackCreated ? ' + Slack' : ''}`;
  if (e.type === 'checkpoint')
    return `${e.eventCreated ? 'Update applied' : 'Baseline checkpoint'} · pre-commit opportunity: ${e.responseOpportunity}`;
  if (e.type === 'decision_output') return e.text.slice(0, 180) || e.stopReason;
  if (e.type === 'termination') return e.reason;
  return 'Inspect recorded evidence';
}
