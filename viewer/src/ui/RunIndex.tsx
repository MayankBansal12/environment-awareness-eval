import { useMemo, useState } from 'react';
import { data } from '../data.js';
import {
  aggregate,
  committedAfterContent,
  classificationTone,
  groupRuns,
  isValid,
  ticketDeliveryOf,
} from '../derive/metrics.js';
import { outcomeLabel, inspectionLabel, humanize } from './labels.js';

const ALL = '__all__';

interface Props {
  onOpen: (runId: string) => void;
  onCompare: (a: string, b: string) => void;
}

export function RunIndex({ onOpen, onCompare }: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [model, setModel] = useState<string>(ALL);
  const [ticket, setTicket] = useState<string>(ALL);
  const [scenario, setScenario] = useState<string>(ALL);
  const [validOnly, setValidOnly] = useState<boolean>(false);

  const models = useMemo(
    () => unique(data.runs.map((run) => run.summary.runtime.model)),
    [],
  );
  const scenarios = useMemo(
    () => unique(data.runs.map((run) => run.summary.scenarioId)),
    [],
  );
  const tickets = useMemo(() => unique(data.runs.map((run) => ticketDeliveryOf(run))), []);

  const filtered = useMemo(
    () =>
      data.runs.filter((run) => {
        if (
          query &&
          !`${run.runId} ${run.summary.runtime.model} ${run.summary.scenarioId} ${outcomeLabel(run.summary.grade.classification)}`
            .toLowerCase()
            .includes(query.toLowerCase())
        )
          return false;
        if (model !== ALL && run.summary.runtime.model !== model) return false;
        if (scenario !== ALL && run.summary.scenarioId !== scenario) return false;
        if (ticket !== ALL && ticketDeliveryOf(run) !== ticket) return false;
        if (validOnly && !isValid(run)) return false;
        return true;
      }),
    [model, scenario, ticket, validOnly, query],
  );

  const cells = useMemo(() => groupRuns(filtered), [filtered]);
  const stats = useMemo(() => aggregate(filtered), [filtered]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h2>Evaluation results</h2>
          <p>How each model noticed an update, responded, and finished the task.</p>
        </div>
        <span className="count-label">
          {stats.total} runs · {cells.length} conditions
        </span>
      </header>
      <div className="summary-cards">
        <div className="card">
          <div className="n">
            {stats.valid}
            <span className="stat-denominator"> / {stats.total}</span>
          </div>
          <div className="k">Valid runs</div>
        </div>
        {stats.byClassification.map((entry) => (
          <div className="card" key={entry.classification}>
            <div className="n">{entry.count}</div>
            <div className="k">{outcomeLabel(entry.classification)}</div>
          </div>
        ))}
      </div>
      <div className="controls index-controls">
        <input
          type="search"
          aria-label="Search runs"
          placeholder="Search runs…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label>
          Model <Select value={model} onChange={setModel} options={models} />
        </label>
        <label>
          Ticket <Select value={ticket} onChange={setTicket} options={tickets} />
        </label>
        <label>
          Scenario <Select value={scenario} onChange={setScenario} options={scenarios} />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={validOnly}
            onChange={(event) => setValidOnly(event.target.checked)}
          />
          Valid only
        </label>
      </div>
      <div className="results-table-wrap">
        <table className="grid results-table">
          <thead>
            <tr>
              <th>Scenario / run</th>
              <th>Model</th>
              <th>Outcome</th>
              <th>Update inspection</th>
              <th>After update</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cells.flatMap((cell) =>
              cell.runs.map(({ run, round }) => {
                const metrics = run.summary.grade.metrics;
                const other = cell.runs.find((entry) => entry.run.runId !== run.runId)?.run;
                return (
                  <tr
                    key={run.runId}
                    className="result-row"
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest('button, a'))
                        onOpen(run.runId);
                    }}
                  >
                    <td>
                      <button className="run-open" onClick={() => onOpen(run.runId)}>
                        {humanize(cell.scenarioId)}
                        <span aria-hidden="true"> ↗</span>
                      </button>
                      <div className="cell-secondary" title={run.runId}>
                        Run {round} · {cell.ticketDelivery} ticket
                      </div>
                    </td>
                    <td>
                      <span className="model-name">{cell.model}</span>
                    </td>
                    <td>
                      <span className={`outcome-badge ${classificationTone(run)}`}>
                        {!isValid(run)
                          ? 'Invalid run'
                          : outcomeLabel(run.summary.grade.classification)}
                      </span>
                    </td>
                    <td>{inspectionLabel(metrics)}</td>
                    <td>
                      <span>
                        {metrics.mutationsAfterContent ?? '—'}{' '}
                        {metrics.mutationsAfterContent === 1 ? 'edit' : 'edits'}
                      </span>
                      <span
                        className={`cell-secondary ${committedAfterContent(run.summary) ? 'warn' : ''}`}
                      >
                        {metrics.commitsAfterContent ?? '—'}{' '}
                        {metrics.commitsAfterContent === 1 ? 'commit' : 'commits'}
                      </span>
                    </td>
                    <td>
                      {other && (
                        <button
                          className="compare-run"
                          aria-label={`Compare ${run.runId} with ${other.runId}`}
                          onClick={() => onCompare(run.runId, other.runId)}
                        >
                          Compare
                        </button>
                      )}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
        {filtered.length === 0 && data.runs.length > 0 && (
          <div className="no-results">
            <h3>No matching runs</h3>
            <p>Try a different search or clear your filters.</p>
            <button
              onClick={() => {
                setQuery('');
                setModel(ALL);
                setTicket(ALL);
                setScenario(ALL);
                setValidOnly(false);
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
      <details className="reading-guide">
        <summary>How to read these results</summary>
        <p>
          Each row is one model run. Inspection measures decisions between seeing an update
          indicator and receiving its content. Edits and commits count actions after the
          content entered context; they do not change the recorded outcome. Invalid runs are
          excluded from outcome counts. Compare opens another repeat of the same condition.
        </p>
      </details>

      {data.runs.length === 0 && data.quarantined.length === 0 && (
        <div className="banner">
          <h3>NO RUNS LOADED</h3>
          <ul>
            <li>
              No run directories were found in <b>{data.resultsDir}</b>. Point the build at
              the full corpus with <b>EAW_RESULTS_DIR=&lt;dir&gt; pnpm viz</b> or{' '}
              <b>pnpm viz --results &lt;dir&gt;</b>.
            </li>
          </ul>
        </div>
      )}

      {data.quarantined.length > 0 && (
        <div className="banner">
          <h3>QUARANTINED — {data.quarantined.length}</h3>
          <ul>
            {data.quarantined.map((run) => (
              <li key={run.runId}>
                <span className="pill invalid">QUARANTINED ⚠</span> <b>{run.runId}</b>{' '}
                {run.claimedVersion !== null && (
                  <span className="kv">claimed trace v{run.claimedVersion}</span>
                )}{' '}
                <span className="kv">{run.reason}</span>
              </li>
            ))}
          </ul>
          <p className="legend">
            Quarantined runs could not be parsed and are excluded from every aggregate
            above; everything else still renders.
          </p>
        </div>
      )}
    </>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
}): JSX.Element {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value={ALL}>All</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
