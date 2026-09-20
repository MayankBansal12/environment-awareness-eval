import { useState } from 'react';
import { filterRuns, LOADS, NO_FILTERS, type RunFilters } from '../derive.js';
import { modelName, modelResults, type ModelResult } from '../derive/results.js';
import { minutes, tokens, usd } from '../format.js';
import type { ViewerIndex } from '../model.js';
import { href } from './App.js';
import { prefetchRun } from '../data.js';

const OPTIONS: Record<keyof RunFilters, string[]> = {
  scenario: ['updates', 'task-cancellation', 'urgency-downgrade', 'delayed-relevance'],
  experiment: [],
  family: ['settlement', 'fulfillment'],
  load: [...LOADS],
  noise: ['none', 'normal', 'heavy'],
  delivery: ['ambient', 'exposed', 'interrupt'],
  updates: ['enabled', 'disabled'],
};
type SortKey = keyof ModelResult;
const sortValue = (r: ModelResult, k: SortKey): string | number =>
  k === 'runs' ? r.runs.length : r[k];

export function RunList({ index, query }: { index: ViewerIndex; query: URLSearchParams }) {
  const filters: RunFilters = { ...NO_FILTERS };
  for (const k of Object.keys(NO_FILTERS) as Array<keyof RunFilters>)
    filters[k] = query.get(k) ?? '';
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'model', dir: 1 });
  const setFilter = (k: keyof RunFilters, v: string) => {
    const next = Object.fromEntries(
      Object.entries({ ...filters, [k]: v }).filter(([, value]) => value),
    );
    location.hash = href.runs(next);
  };
  const experiments = [...new Set(index.runs.map((r) => r.experiment ?? 'dev'))].sort();
  const rows = filterRuns(index.runs, filters);
  const models = modelResults(rows).sort((a, b) => {
    const x = sortValue(a, sort.key),
      y = sortValue(b, sort.key);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
  const th = (key: SortKey, label: string, numeric = false) => (
    <th
      className={`sortable${numeric ? ' num' : ''}`}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      <button
        className="table-sort"
        onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 })}
      >
        {label}
        {sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  if (!index.runs.length)
    return (
      <section className="empty">
        <h2>No v4 runs found</h2>
        <p>
          Looked in <code>{index.resultsDir}</code>. Run <code>pnpm eval run …</code>, or
          point the build elsewhere with <code>EAW_RESULTS_DIR=&lt;dir&gt; pnpm viz</code>.
        </p>
        <Skipped index={index} />
      </section>
    );

  return (
    <section>
      <header className="page-heading">
        <div>
          <h2>Evaluation results</h2>
          <p>
            Saved and new runs. Filter by experiment and scenario to compare like
            conditions.
          </p>
        </div>
        <span className="count-label">
          {models.length} {models.length === 1 ? 'model' : 'models'} · {rows.length}{' '}
          {rows.length === 1 ? 'run' : 'runs'}
        </span>
      </header>
      <div className="summary-cards">
        <div className="card">
          <div className="n">
            {rows.filter((r) => r.valid && !r.censored).length}
            <span className="stat-denominator"> / {rows.length}</span>
          </div>
          <div className="k">Valid, uncensored runs</div>
        </div>
        <div className="card">
          <div className="n">
            {rows
              .filter((r) => r.valid && !r.censored)
              .reduce((n, r) => n + r.importantMissed, 0)}
          </div>
          <div className="k">Missed updates</div>
        </div>
        <div className="card">
          <div className="n">{usd(rows.reduce((n, r) => n + r.costUsd, 0))}</div>
          <div className="k">Total cost</div>
        </div>
      </div>
      <div className="controls index-controls">
        {(Object.keys(OPTIONS) as Array<keyof RunFilters>).map((k) => (
          <label key={k}>
            {k}
            <select value={filters[k]} onChange={(e) => setFilter(k, e.target.value)}>
              <option value="">all</option>
              {(k === 'experiment' ? experiments : OPTIONS[k]).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        ))}
        <span className="muted small">
          {rows.length} of {index.runs.length} runs
        </span>
      </div>
      <div className="results-table-wrap">
        <table className="grid results-table model-results-table">
          <thead>
            <tr>
              {th('model', 'Model')}
              {th('runs', 'Runs', true)}
              {th('finishedRuns', 'Finished', true)}
              {th('validRuns', 'Valid', true)}
              {th('importantMissed', 'Missed updates', true)}
              {th('decisions', 'Total decisions', true)}
              {th('totalTokens', 'Total tokens', true)}
              {th('costUsd', 'Total cost', true)}
              {th('durationMs', 'Total duration', true)}
            </tr>
          </thead>
          <tbody>
            {models.map((r) => (
              <tr
                className="result-row"
                key={r.model}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('a, button'))
                    location.hash = href.run(r.runs[0]!.key);
                }}
              >
                <td>
                  <a
                    href={href.run(r.runs[0]!.key)}
                    onPointerEnter={() => prefetchRun(r.runs[0]!.key)}
                    onFocus={() => prefetchRun(r.runs[0]!.key)}
                  >
                    {modelName(r.model)}
                  </a>
                  <div className="muted small">View runs →</div>
                </td>
                <td className="num">{r.runs.length}</td>
                <td className="num">
                  {r.finishedRuns}/{r.runs.length}
                </td>
                <td className="num">
                  {r.validRuns}/{r.runs.length}
                </td>
                <td className="num">
                  {r.importantFired ? `${r.importantMissed}/${r.importantFired}` : '—'}
                </td>
                <td className="num">{r.decisions}</td>
                <td className="num">{tokens(r.totalTokens)}</td>
                <td className="num">{usd(r.costUsd)}</td>
                <td className="num">{minutes(r.durationMs)}</td>
              </tr>
            ))}
            {!models.length && (
              <tr>
                <td colSpan={9} className="muted">
                  No runs match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Valid and missed-update counts use valid, uncensored runs. Usage and duration are
        totals across all matching runs.
      </p>
      <Skipped index={index} />
    </section>
  );
}

function Skipped({ index }: { index: ViewerIndex }) {
  if (!index.skipped.length) return null;
  return (
    <details className="skipped">
      <summary>{index.skipped.length} directories skipped (not v4)</summary>
      <ul>
        {index.skipped.map((s) => (
          <li key={s.path}>
            <code>{s.path}</code> — {s.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}
