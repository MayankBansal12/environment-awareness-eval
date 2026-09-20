import { useState } from 'react';
import type { ImportantKind } from '../../../src/scenario.js';
import {
  cellEvent,
  importantKinds,
  KIND_LABEL,
  LOADS,
  trendGroups,
  type Cell,
  type TrendGroup,
} from '../derive.js';
import { num, pct, tokens, usd } from '../format.js';
import type { ViewerIndex } from '../model.js';
import { href } from './App.js';

type Interval = { proportion: number | null; interval95: number[] | null; n: number };
const ci = (f: Interval) =>
  f.proportion === null ? (
    '—'
  ) : (
    <>
      {pct(f.proportion)}{' '}
      <span className="muted small">
        [{pct(f.interval95![0])}–{pct(f.interval95![1])}] n={f.n}
      </span>
    </>
  );

export function ExperimentView({ index, id }: { index: ViewerIndex; id: string }) {
  const entry = index.experiments.find((e) => e.id === id);
  const [kind, setKind] = useState<ImportantKind>('requirement_change');
  if (!entry) return <p className="error">Experiment {id} not found.</p>;
  const c = entry.comparison;
  const groups = trendGroups(c);
  const cells = groups.flatMap((g) =>
    LOADS.flatMap((l) => (g.byLoad[l] ? [g.byLoad[l]] : [])),
  );

  return (
    <section className="experiment">
      <div className="run-header">
        <div>
          <h1>{c.manifest}</h1>
          <div className="chips">
            <span>{entry.profile}</span>
            <span>{c.model}</span>
            <span>
              {c.completed}/{c.scheduled} trials completed
            </span>
            <a href={href.runs({ experiment: c.manifest })}>runs →</a>
          </div>
          <p className="small muted">{c.note}</p>
        </div>
      </div>

      {!!c.baselines?.length && (
        <div className="card">
          <h2>Saved baseline</h2>
          <p>
            Historical results, excluded from the new trial totals. Original scores and
            traces are preserved.
          </p>
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Script</th>
                <th>Grader</th>
                <th>Valid</th>
              </tr>
            </thead>
            <tbody>
              {c.baselines.map((b) => {
                const row = index.runs.find((r) =>
                  b.path.endsWith('/' + r.key + '/summary.json'),
                );
                return (
                  <tr key={b.path}>
                    <td>{row ? <a href={href.run(row.key)}>{b.runId}</a> : b.runId}</td>
                    <td>{String(b.scriptVersion ?? '—')}</td>
                    <td>{b.graderVersion}</td>
                    <td>{String(b.valid)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Load trend</h2>
        <p className="legend small">
          {importantKinds.map((k) => (
            <span key={k}>
              <span className={`swatch fill-${k}`} /> {KIND_LABEL[k]}
            </span>
          ))}
          <span className="muted">
            Whiskers: 95% Wilson interval. Hover a point for values.
          </span>
        </p>
        {groups.map((g) => (
          <Trend key={g.key} group={g} />
        ))}
      </div>

      <div className="card">
        <div className="inspector-head">
          <h2>Cells</h2>
          <div className="tabs" role="tablist">
            {importantKinds.map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
              >
                <span className={`swatch fill-${k}`} /> {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Cell</th>
              <th className="num">Valid</th>
              <th className="num">Censored</th>
              <th>Missed (95% CI)</th>
              <th className="num">Latency median</th>
              <th>Adapted (95% CI)</th>
              <th className="num">Failing checks at fire</th>
              <th className="num">Context at fire</th>
              <th className="num">Focal edits before content</th>
              <th className="num">Tokens / run</th>
              <th className="num">Cost / run</th>
              <th className="num">Cost total</th>
            </tr>
          </thead>
          <tbody>
            {cells.map((cell) => {
              const e = cellEvent(cell, kind);
              return (
                <tr key={cell.cell}>
                  <td>
                    <a href={href.runs(filterOf(c.manifest, cell))}>{cell.cell}</a>
                  </td>
                  <td className="num">
                    {cell.valid}/{cell.scheduled}
                  </td>
                  <td className="num">{cell.censored}</td>
                  <td>{ci(e.missed)}</td>
                  <td className="num">{num(e.detectionLatencyMedian)}</td>
                  <td>{ci(e.adapted)}</td>
                  <td className="num">{num(e.focalChecksFailingAtFireMean)}</td>
                  <td className="num">
                    {e.contextTokensAtFireMean === null
                      ? '—'
                      : tokens(Math.round(e.contextTokensAtFireMean))}
                  </td>
                  <td className="num">{num(e.focalChangesBeforeContentMean)}</td>
                  <td className="num">
                    {cell.usage.totalTokensMean === null
                      ? '—'
                      : tokens(Math.round(cell.usage.totalTokensMean))}
                  </td>
                  <td className="num">{usd(cell.usage.costUsdMean)}</td>
                  <td className="num">{usd(cell.usage.costUsdTotal)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="card">
        <summary>
          <h2>Trials</h2>
        </summary>
        <table>
          <thead>
            <tr>
              <th>Trial</th>
              <th>Cell</th>
              <th className="num">Replicate</th>
              <th>Attempts</th>
              <th>Termination</th>
              <th>Valid</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {c.trials.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>{t.cell}</td>
                <td className="num">{t.replicate}</td>
                <td>
                  {t.attempts.map((a) => (
                    <a
                      key={a.id}
                      className="attempt"
                      href={href.run(`${c.manifest}/runs/${a.id}`)}
                    >
                      {a.id} <span className="muted">{a.state}</span>
                    </a>
                  ))}
                </td>
                <td>{t.termination ?? '—'}</td>
                <td>{t.valid === null ? '—' : t.valid ? 'yes' : 'no'}</td>
                <td className="num">
                  {t.totalTokens === null ? '—' : tokens(t.totalTokens)}
                </td>
                <td className="num">{usd(t.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

const filterOf = (experiment: string, cell: Cell) => {
  const [family, load, noise, delivery, scenario, control] = cell.cell.split('/') as [
    string,
    string,
    string,
    string,
    string?,
    string?,
  ];
  return {
    experiment,
    family,
    load,
    noise,
    delivery,
    scenario: scenario ?? 'updates',
    updates: control === 'noise-only-control' ? 'disabled' : 'enabled',
  };
};

const W = 230,
  H = 150,
  PAD = { l: 38, r: 12, t: 12, b: 24 };

/** Small multiples over load: one axis each, the four updates as fixed-order series. */
function Trend({ group }: { group: TrendGroup }) {
  const loads = LOADS.filter((l) => group.byLoad[l]);
  const xs = (i: number) => PAD.l + ((i + 0.5) * (W - PAD.l - PAD.r)) / loads.length;
  const charts: Array<{
    title: string;
    value: (cell: Cell, k: ImportantKind) => number | null;
    interval?: (cell: Cell, k: ImportantKind) => number[] | null;
    format: (v: number) => string;
    fixedMax?: number;
    perKind: boolean;
  }> = [
    {
      title: 'Missed rate (95% CI)',
      value: (c, k) => cellEvent(c, k).missed.proportion,
      interval: (c, k) => cellEvent(c, k).missed.interval95,
      format: (v) => pct(v),
      fixedMax: 1,
      perKind: true,
    },
    {
      title: 'Detection latency (median decisions)',
      value: (c, k) => cellEvent(c, k).detectionLatencyMedian,
      format: (v) => num(v),
      perKind: true,
    },
    {
      title: 'Failing focal checks at fire',
      value: (c, k) => cellEvent(c, k).focalChecksFailingAtFireMean,
      format: (v) => num(v),
      perKind: true,
    },
    {
      title: 'Cost per run',
      value: (c) => c.usage.costUsdMean,
      format: (v) => usd(v),
      perKind: false,
    },
  ];

  return (
    <div className="trend">
      <h3>
        {group.key.replaceAll('/', ' · ')}
        {loads.length < 2 && <span className="muted small"> (single load; control)</span>}
      </h3>
      <div className="multiples">
        {charts.map((chart) => {
          const series = chart.perKind ? importantKinds : (['all'] as const);
          const values = loads.flatMap((l) =>
            series.flatMap((k) => {
              const cell = group.byLoad[l]!;
              const kk = (k === 'all' ? 'requirement_change' : k) as ImportantKind;
              return [chart.value(cell, kk) ?? 0, ...(chart.interval?.(cell, kk) ?? [])];
            }),
          );
          const max = chart.fixedMax ?? Math.max(1e-9, ...values) * 1.15;
          const ys = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
          const offset = (si: number) => (series.length > 1 ? (si - 1.5) * 7 : 0);
          return (
            <figure key={chart.title}>
              <figcaption className="small">{chart.title}</figcaption>
              <svg width={W} height={H} role="img" aria-label={`${chart.title} by load`}>
                {[0, max / 2, max].map((t) => (
                  <g key={t}>
                    <line
                      className="grid"
                      x1={PAD.l}
                      x2={W - PAD.r}
                      y1={ys(t)}
                      y2={ys(t)}
                    />
                    <text
                      className="axis"
                      x={PAD.l - 5}
                      y={ys(t)}
                      dy="0.35em"
                      textAnchor="end"
                    >
                      {chart.format(t)}
                    </text>
                  </g>
                ))}
                {loads.map((l, i) => (
                  <text key={l} className="axis" x={xs(i)} y={H - 6} textAnchor="middle">
                    {l}
                  </text>
                ))}
                {series.map((k, si) => {
                  const kk = (k === 'all' ? 'requirement_change' : k) as ImportantKind;
                  const pts = loads.map((l, i) => ({
                    x: xs(i) + offset(si),
                    v: chart.value(group.byLoad[l]!, kk),
                    ci: chart.interval?.(group.byLoad[l]!, kk) ?? null,
                    l,
                  }));
                  const cls = k === 'all' ? 'series-neutral' : k;
                  const drawn = pts.filter((p) => p.v !== null);
                  return (
                    <g key={k}>
                      {drawn.length > 1 && (
                        <polyline
                          className={`trend-line stroke-${cls}`}
                          points={drawn.map((p) => `${p.x},${ys(p.v!)}`).join(' ')}
                        />
                      )}
                      {drawn.map((p) => (
                        <g key={p.l}>
                          {p.ci && (
                            <line
                              className={`whisker stroke-${cls}`}
                              x1={p.x}
                              x2={p.x}
                              y1={ys(p.ci[0]!)}
                              y2={ys(p.ci[1]!)}
                            />
                          )}
                          <circle
                            className={`fill-${cls} ring`}
                            cx={p.x}
                            cy={ys(p.v!)}
                            r={4}
                          >
                            <title>
                              {`${k === 'all' ? '' : `${KIND_LABEL[kk]} · `}${p.l}: ${chart.format(p.v!)}${p.ci ? ` (95% CI ${pct(p.ci[0])}–${pct(p.ci[1])})` : ''}`}
                            </title>
                          </circle>
                        </g>
                      ))}
                    </g>
                  );
                })}
              </svg>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
