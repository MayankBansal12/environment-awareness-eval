import { useState } from 'react';
import type { Bundle } from '../../../src/v3/schema.js';

export function V3Runs({
  runs,
  initialRunId = null,
}: {
  runs: Bundle[];
  initialRunId?: string | null;
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(initialRunId),
    [decision, setDecision] = useState<number | null>(null);
  const run = runs.find((r) => r.id === selected);
  if (!run)
    return (
      <section>
        <header className="page-heading">
          <div>
            <h2>Switching and resumption</h2>
            <p>
              Development calibration: task completion, urgent interruption, and return to
              paused work.
            </p>
          </div>
          <span>{runs.length} runs</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Sequence / delivery</th>
              <th>Urgent demand</th>
              <th>Validity</th>
              <th>Outcome</th>
              <th>Decisions</th>
              <th>Discovery delay</th>
              <th>Resumption delay</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <button
                    onClick={() => {
                      setSelected(r.id);
                      setDecision(null);
                    }}
                  >
                    {r.id}
                  </button>
                </td>
                <td>
                  {r.summary.sequence} / {r.summary.delivery}
                </td>
                <td>{r.summary.demand}</td>
                <td>
                  {(r.analysis?.grade ?? r.summary.grade).valid ? 'Valid' : 'Invalid'}
                </td>
                <td>
                  {(r.analysis?.grade ?? r.summary.grade).outcome.replaceAll('_', ' ')}
                </td>
                <td>{String((r.analysis?.grade ?? r.summary.grade).metrics.decisions)}</td>
                <td>
                  {String(
                    (r.analysis?.grade ?? r.summary.grade).metrics.discoveryDelay ?? '—',
                  )}
                </td>
                <td>
                  {String(
                    (r.analysis?.grade ?? r.summary.grade).metrics.resumptionDelay ?? '—',
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Single development trajectories do not establish a cognitive-load effect. Provider
          failures remain separate from behavior.
        </p>
      </section>
    );
  const { summary, trace, context } = run,
    grade = run.analysis?.grade ?? summary.grade,
    inputs = context.filter((c) => c.type === 'input'),
    d = decision ?? inputs.at(-1)?.decision ?? 0;
  const input = inputs.find((c) => c.decision === d),
    output = context.find((c) => c.type === 'output' && c.decision === d);
  return (
    <section>
      <button onClick={() => setSelected(null)}>← All switching runs</button>
      <h2>{run.id}</h2>
      <p>
        {summary.sequence} / {summary.delivery} / {summary.demand} urgent demand ·{' '}
        {grade.outcome.replaceAll('_', ' ')} · {summary.termination.reason}
      </p>
      {run.analysis && (
        <p>
          Derived analysis {run.analysis.analysisVersion}. Original outcome:{' '}
          {summary.grade.outcome.replaceAll('_', ' ')}. Original artifacts are preserved.
        </p>
      )}
      <div className="v2-grid">
        <div>
          <h3>Per-task checks</h3>
          <pre>{JSON.stringify(run.analysis?.evidence ?? summary.evidence, null, 2)}</pre>
        </div>
        <div>
          <h3>Workflow and evidence</h3>
          <pre>
            {JSON.stringify(
              {
                gates: grade.gates,
                metrics: grade.metrics,
                audit: summary.audit,
              },
              null,
              2,
            )}
          </pre>
        </div>
      </div>
      <p>
        Coverage quality and factual reporting require manual review. Reading a ticket is
        evidence of retrieval, not proof of internal awareness.
      </p>
      {['3.1.0', '3.1.1'].includes(String(grade.metrics.graderVersion)) && (
        <p>
          Urgent work remaining at its first edit:{' '}
          {String(grade.metrics.urgentChecksRemainingAtCheckpoint ?? 'unavailable')} failing
          checks. Revision opportunity during urgent work:{' '}
          {String(
            grade.metrics.revisionResponseOpportunityDuringUrgent ?? 'not applicable',
          )}
          . Priority assessment: {String(grade.metrics.priorityAssessment)}. The feature
          before interruption is identical across demand variants.
        </p>
      )}
      <details>
        <summary>Final board</summary>
        <pre>{JSON.stringify(summary.team, null, 2)}</pre>
      </details>
      <h3>Decision timeline</h3>
      <div className="v2-decisions">
        {inputs.map((i) => (
          <button
            key={i.decision}
            onClick={() => setDecision(i.decision)}
            className={i.decision === d ? 'active' : ''}
          >
            D{i.decision}
          </button>
        ))}
      </div>
      <pre>
        {JSON.stringify(
          trace.filter((e) => e.decision === d),
          null,
          2,
        )}
      </pre>
      <div className="v2-grid">
        <div>
          <h3>Actual input to D{d}</h3>
          {input?.messages.map((m, i) => (
            <details key={i} open={i >= input.messages.length - 2}>
              <summary>
                {m.role} {m.toolName ?? ''}
              </summary>
              <pre>{JSON.stringify(m.blocks ?? m.text, null, 2)}</pre>
            </details>
          ))}
        </div>
        <div>
          <h3>Assistant output</h3>
          <pre>
            {output?.type === 'output'
              ? JSON.stringify(output.message.blocks ?? output.message.text, null, 2)
              : 'No output captured'}
          </pre>
        </div>
      </div>
      <details>
        <summary>Runtime and prompt</summary>
        <pre>
          {JSON.stringify(
            context.find((c) => c.type === 'header'),
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
