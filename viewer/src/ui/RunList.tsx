import { useState } from 'react';
import { filterRuns, LOADS, NO_FILTERS, type RunFilters } from '../derive.js';
import { minutes, tokens, usd } from '../format.js';
import type { RunRow, ViewerIndex } from '../model.js';
import { href } from './App.js';
import { Status } from './Status.js';

const OPTIONS: Record<keyof RunFilters, string[]> = {
  experiment: [],
  family: ['settlement', 'fulfillment'],
  load: [...LOADS],
  noise: ['none', 'normal', 'heavy'],
  delivery: ['ambient', 'exposed'],
};
type SortKey =
  'key' | 'load' | 'decisions' | 'totalTokens' | 'costUsd' | 'durationMs' | 'missed';
const sortValue = (r: RunRow, k: SortKey): string | number =>
  k === 'load'
    ? LOADS.indexOf(r.condition.load)
    : k === 'missed'
      ? r.importantMissed
      : k === 'key'
        ? r.key
        : r[k];

export function RunList({ index, query }: { index: ViewerIndex; query: URLSearchParams }) {
  const filters: RunFilters = { ...NO_FILTERS };
  for (const k of Object.keys(NO_FILTERS) as Array<keyof RunFilters>)
    filters[k] = query.get(k) ?? '';
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'key', dir: 1 });
  const setFilter = (k: keyof RunFilters, v: string) => {
    const next = Object.fromEntries(
      Object.entries({ ...filters, [k]: v }).filter(([, value]) => value),
    );
    location.hash = href.runs(next);
  };
  const experiments = [...new Set(index.runs.map((r) => r.experiment ?? 'dev'))].sort();
  const rows = filterRuns(index.runs, filters).sort((a, b) => {
    const x = sortValue(a, sort.key),
      y = sortValue(b, sort.key);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
  const th = (key: SortKey, label: string, numeric = false) => (
    <th
      className={`sortable${numeric ? ' num' : ''}`}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 })}
    >
      {label}
      {sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
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
      <div className="filters">
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
      <table className="runs">
        <thead>
          <tr>
            {th('key', 'Run')}
            <th>Family</th>
            {th('load', 'Load')}
            <th>Noise</th>
            <th>Delivery</th>
            <th>Model</th>
            <th>Termination</th>
            <th>Validity</th>
            {th('missed', 'Missed', true)}
            {th('decisions', 'Decisions', true)}
            {th('totalTokens', 'Tokens', true)}
            {th('costUsd', 'Cost', true)}
            {th('durationMs', 'Duration', true)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} onClick={() => (location.hash = href.run(r.key))}>
              <td>
                <a href={href.run(r.key)}>{r.runId}</a>
                <div className="muted small">{r.experiment ?? 'dev'}</div>
              </td>
              <td>{r.condition.family}</td>
              <td>
                <span className={`load load-${r.condition.load}`}>{r.condition.load}</span>
              </td>
              <td>{r.condition.noise}</td>
              <td>{r.condition.delivery}</td>
              <td className="small">{r.model}</td>
              <td className="small">{r.termination}</td>
              <td>
                <Status valid={r.valid} censored={r.censored} />
              </td>
              <td className="num">
                {r.importantMissed}/{r.importantFired}
              </td>
              <td className="num">{r.decisions}</td>
              <td className="num">{tokens(r.totalTokens)}</td>
              <td className="num">{usd(r.costUsd)}</td>
              <td className="num">{minutes(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
