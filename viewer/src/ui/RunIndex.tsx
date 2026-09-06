/**
 * Screen 1 — the run index.
 *
 * Repeats of one cell are columns, not rows, so run-to-run variance in the same condition
 * is visible without opening anything. Invalid runs are struck through and are excluded
 * from the aggregate counts above the table.
 */

import { useMemo, useState } from 'react';
import { data } from '../data.js';
import {
  aggregate,
  committedAfterContent,
  formatAfterContent,
  formatIndicatorToContent,
  groupRuns,
  isValid,
  ticketDeliveryOf,
} from '../derive/metrics.js';
import type { RunBundle } from '../derive/model.js';

const ALL = '__all__';

interface Props {
  onOpen: (runId: string) => void;
  onCompare: (a: string, b: string) => void;
}

export function RunIndex({ onOpen, onCompare }: Props): JSX.Element {
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
  const tickets = useMemo(
    () => unique(data.runs.map((run) => ticketDeliveryOf(run))),
    [],
  );

  const filtered = useMemo(
    () =>
      data.runs.filter((run) => {
        if (model !== ALL && run.summary.runtime.model !== model) return false;
        if (scenario !== ALL && run.summary.scenarioId !== scenario) return false;
        if (ticket !== ALL && ticketDeliveryOf(run) !== ticket) return false;
        if (validOnly && !isValid(run)) return false;
        return true;
      }),
    [model, scenario, ticket, validOnly],
  );

  const cells = useMemo(() => groupRuns(filtered), [filtered]);
  const stats = useMemo(() => aggregate(filtered), [filtered]);
  const maxRounds = cells.reduce((max, cell) => Math.max(max, cell.runs.length), 0);

  return (
    <>
      <div className="controls">
        <label>
          model
          <Select value={model} onChange={setModel} options={models} />
        </label>
        <label>
          ticket
          <Select value={ticket} onChange={setTicket} options={tickets} />
        </label>
        <label>
          scenario
          <Select value={scenario} onChange={setScenario} options={scenarios} />
        </label>
        <label>
          <input
            type="checkbox"
            checked={validOnly}
            onChange={(event) => setValidOnly(event.target.checked)}
          />
          valid only
        </label>
      </div>

      <div className="summary-cards">
        <div className="card">
          <div className="n">{stats.total}</div>
          <div className="k">runs shown</div>
        </div>
        <div className="card">
          <div className="n">{stats.valid}</div>
          <div className="k">valid</div>
        </div>
        {stats.byClassification.slice(0, 4).map((entry) => (
          <div className="card" key={entry.classification}>
            <div className="n">{entry.count}</div>
            <div className="k">{entry.classification}</div>
          </div>
        ))}
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>scenario</th>
            <th>ticket</th>
            {Array.from({ length: Math.max(maxRounds, 1) }, (_, index) => (
              <th key={index} className="num">
                R{index + 1}
              </th>
            ))}
            <th>ind→con</th>
            <th>after</th>
            <th>outcome</th>
            <th>trace</th>
            <th>runs</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => {
            // The row's metric columns describe the first valid repeat; the per-round
            // marks above them are what shows variance across repeats.
            const representative =
              cell.runs.find((entry) => isValid(entry.run))?.run ?? cell.runs[0]?.run;
            if (representative === undefined) return null;
            const allInvalid = cell.runs.every((entry) => !isValid(entry.run));
            const committed = cell.runs.some(
              (entry) => isValid(entry.run) && committedAfterContent(entry.run.summary),
            );
            return (
              <tr
                key={`${cell.model}/${cell.scenarioId}/${cell.ticketDelivery}`}
                className={allInvalid ? 'invalid-row' : ''}
              >
                <td>{cell.scenarioId}</td>
                <td>{cell.ticketDelivery}</td>
                {Array.from({ length: Math.max(maxRounds, 1) }, (_, index) => {
                  const entry = cell.runs[index];
                  return (
                    <td key={index} className="num">
                      {entry === undefined ? (
                        <span className="expandable">·</span>
                      ) : (
                        <RoundMark run={entry.run} onOpen={onOpen} />
                      )}
                    </td>
                  );
                })}
                <td>{formatIndicatorToContent(representative.summary.grade.metrics)}</td>
                <td className={committed ? 'warn' : ''}>
                  {formatAfterContent(representative.summary.grade.metrics)}
                </td>
                <td className={committed ? 'warn' : ''}>
                  {representative.summary.grade.classification}
                  {committed ? ' ⚠' : ''}
                </td>
                <td>
                  {cell.runs.length >= 2 && (
                    <button
                      onClick={() =>
                        onCompare(cell.runs[0]!.run.runId, cell.runs[1]!.run.runId)
                      }
                    >
                      compare
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="legend">
        IND→CON = decisions / actions from indicator exposure to content exposure; “—” means
        no indicator was ever exposed, “never” means the indicator appeared but the content
        never did. AFTER = mutations · commits after content exposure. Struck-through rows
        are invalid runs and are excluded from the counts above. Click a round mark to open
        the run.
      </p>

      {data.runs.length === 0 && data.quarantined.length === 0 && (
        <div className="banner">
          <h3>NO RUNS LOADED</h3>
          <ul>
            <li>
              No run directories were found in <b>{data.resultsDir}</b>. Point the build
              at the full corpus with <b>EAW_RESULTS_DIR=&lt;dir&gt; pnpm viz</b> or{' '}
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

function RoundMark({
  run,
  onOpen,
}: {
  run: RunBundle;
  onOpen: (runId: string) => void;
}): JSX.Element {
  const valid = isValid(run);
  const bad = committedAfterContent(run.summary);
  const className = !valid ? 'round invalid' : bad ? 'round bad' : 'round ok';
  return (
    <span
      className={className}
      title={`${run.runId}\n${run.summary.grade.classification}\nvalid: ${String(valid)}`}
      onClick={() => onOpen(run.runId)}
    >
      {!valid ? '✗' : bad ? '⚠' : '✓'}
    </span>
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
      <option value={ALL}>all</option>
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
