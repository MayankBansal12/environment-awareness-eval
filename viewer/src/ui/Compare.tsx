/** Original comparison cells, aligned in shared decision rows so variable action counts cannot drift. */
import { useMemo } from 'react';
import { useRun } from '../data.js';
import type { RunDetail, ViewerIndex } from '../model.js';
import { actionRowsOf, markerRowsOf } from '../derive/timeline.js';
import { PHASE_GLYPH } from '../derive/phases.js';
import { conditionLabel, outcomeLabel } from '../derive/metrics.js';
import { href } from './App.js';
export function Compare({
  index,
  initialA,
  initialB,
}: {
  index: ViewerIndex;
  initialA: string | null;
  initialB: string | null;
}) {
  const aKey = initialA ?? index.runs[0]?.key ?? '';
  const bKey = initialB ?? index.runs[1]?.key ?? aKey;
  const a = useRun(aKey),
    b = useRun(bKey);
  if (!index.runs.length) return <p>No runs available to compare.</p>;
  const select = (side: number, value: string) => {
    location.hash = href.compare(side === 0 ? value : aKey, side === 1 ? value : bKey);
  };
  return (
    <>
      <div className="controls">
        {[aKey, bKey].map((value, i) => (
          <label key={i}>
            {i === 0 ? 'A' : 'B'}
            <select
              aria-label={`Run ${i === 0 ? 'A' : 'B'}`}
              value={value}
              onChange={(e) => select(i, e.target.value)}
            >
              {index.runs.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.key} · {conditionLabel(r)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {a.error || b.error ? (
        <p className="error">{a.error ?? b.error}</p>
      ) : a.data && b.data ? (
        <Comparison a={a.data} b={b.data} />
      ) : (
        <p>Loading comparison…</p>
      )}
    </>
  );
}
export function Comparison({ a, b }: { a: RunDetail; b: RunDetail }) {
  const sides = useMemo(
    () =>
      [a, b].map((run) => ({
        run,
        actions: actionRowsOf(run),
        markers: markerRowsOf(run.trace),
      })),
    [a, b],
  );
  const max = Math.max(
    1,
    ...a.trace.map((e) => e.decision),
    ...b.trace.map((e) => e.decision),
  );
  return (
    <>
      <div className="compare aligned-compare">
        {sides.map(({ run }, i) => (
          <h4 key={run.key + i}>
            {i === 0 ? 'A' : 'B'} · <a href={href.run(run.key)}>{run.key}</a>
            <div className="kv">{outcomeLabel(run)}</div>
          </h4>
        ))}
        {Array.from({ length: max }, (_, i) => i + 1).map((d) => (
          <div className="compare-decision" key={d} data-decision={d}>
            {sides.map(({ run, actions, markers }, i) => {
              const present = run.trace.some((e) => e.type === 'input' && e.decision === d);
              return (
                <div className={`compare-cell${present ? '' : ' blank'}`} key={i}>
                  <a className="tl-d" href={href.run(run.key, d)}>
                    D{d}
                  </a>
                  {!present && <span className="kv"> No decision in this run</span>}
                  {[...actions, ...markers]
                    .filter((row) => row.decisionIndex === d)
                    .sort((x, y) => x.seq - y.seq)
                    .map((row) =>
                      row.kind === 'marker' ? (
                        <div className={`cmp-row ${row.marker}`} key={row.seq}>
                          {row.title} · {row.detail}
                        </div>
                      ) : (
                        <div className="cmp-row" key={row.seq}>
                          <span className={`glyph ${row.phase}`}>
                            {PHASE_GLYPH[row.phase]}
                          </span>
                          <span>{row.label}</span>
                          {row.testOutcome && (
                            <span className={`outcome ${row.testOutcome}`}>
                              {row.testOutcome}
                            </span>
                          )}
                        </div>
                      ),
                    )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="cmp-foot">
        <div>A: {outcomeLabel(a)}</div>
        <div>B: {outcomeLabel(b)}</div>
      </div>
    </>
  );
}
