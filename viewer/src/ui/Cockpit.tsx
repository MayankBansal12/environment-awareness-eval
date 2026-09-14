import { useEffect, useMemo } from 'react';
import { useRun } from '../data.js';
import { decisionRows, KIND_LABEL } from '../derive.js';
import { cell, minutes, num, tokens, usd } from '../format.js';
import type { RunDetail } from '../model.js';
import { href } from './App.js';
import { Inspector } from './Inspector.js';
import { Status } from './Status.js';
import { Timeline } from './Timeline.js';

export function Cockpit({ runKey, decision }: { runKey: string; decision: number | null }) {
  const run = useRun(runKey);
  if (run.error) return <p className="error">{run.error}</p>;
  if (!run.data) return <p className="muted">Loading {runKey}…</p>;
  return <RunView run={run.data} decision={decision} />;
}

export function RunView({ run, decision }: { run: RunDetail; decision: number | null }) {
  const s = run.summary;
  const rows = useMemo(() => decisionRows(run.trace), [run]);
  const selected = Math.min(Math.max(decision ?? 1, 1), Math.max(rows.length, 1));
  const select = (d: number) => {
    if (d >= 1 && d <= rows.length) history.replaceState(null, '', href.run(run.key, d));
    dispatchEvent(new HashChangeEvent('hashchange'));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === 'ArrowLeft') select(selected - 1);
      if (e.key === 'ArrowRight') select(selected + 1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  const c = s.condition,
    g = s.grade;
  const noise = s.team.events.filter((e) => !e.important).length;
  const experiment = run.key.includes('/runs/') ? run.key.split('/runs/')[0]! : null;

  return (
    <section className="cockpit">
      <div className="run-header">
        <div>
          <div className="crumbs small">
            <a href={href.runs()}>Runs</a> /{' '}
            {experiment ? <a href={href.experiment(experiment)}>{experiment}</a> : 'dev'}
          </div>
          <h1>
            {s.runId} <Status valid={g.valid} censored={g.censored} />
          </h1>
          <div className="chips">
            <span>{c.family}</span>
            <span className={`load load-${c.load}`}>load {c.load}</span>
            <span>noise {c.noise}</span>
            <span>{c.delivery}</span>
            <span>seed {c.seed}</span>
            <span>
              {cell(s.runtime['provider'])}/{cell(s.runtime['model'])} ·{' '}
              {cell(s.runtime['thinking'])}
            </span>
          </div>
          <p className="small muted">
            {s.termination.reason} — {s.termination.detail}
          </p>
        </div>
        <dl className="tiles">
          <Tile label="Decisions" value={String(s.usage.turnCalls)} />
          <Tile
            label="Missed updates"
            value={`${g.summary['importantMissed'] ?? 0}/${g.summary['importantFired'] ?? 0}`}
          />
          <Tile label="Noise events" value={String(noise)} />
          <Tile label="Tokens" value={tokens(s.usage.totalTokens)} />
          <Tile label="Peak context" value={tokens(s.usage.peakContextTokens)} />
          <Tile label="Cost" value={usd(s.usage.costUsd.total)} />
          <Tile label="Duration" value={minutes(s.durationMs)} />
        </dl>
      </div>

      <div className="card">
        <Timeline rows={rows} metrics={g.events} selected={selected} onSelect={select} />
        <p className="legend small">
          <span>◆ fired</span>
          <span>○ cue seen</span>
          <span>● content read</span>
          <span className="dash">- - missed (never read)</span>
          <span>▮ noise</span>
          <span>Click a decision or use ← → to inspect it.</span>
        </p>
      </div>

      <div className="card">
        <h2>Updates</h2>
        <table>
          <thead>
            <tr>
              <th>Update</th>
              <th>Fired</th>
              <th className="num">Failing focal checks</th>
              <th className="num">Context tokens</th>
              <th className="num">Cue</th>
              <th className="num">Content</th>
              <th className="num">Latency</th>
              <th>Missed</th>
              <th className="num">Focal edits before</th>
              <th className="num">Commits before</th>
              <th className="num">Tool actions before</th>
              <th>Final behavior</th>
            </tr>
          </thead>
          <tbody>
            {g.events.map((e) => (
              <tr key={e.kind}>
                <td>
                  <span className={`swatch fill-${e.kind}`} /> {KIND_LABEL[e.kind]}
                </td>
                <td>
                  {e.fired ? (
                    <a onClick={() => select(e.firedDecision!)}>
                      D{e.firedDecision} · {e.trigger}
                      {e.firedDuringTestFailure ? ' · test failing' : ''}
                    </a>
                  ) : (
                    <span className="muted">not fired</span>
                  )}
                </td>
                <td className="num">{num(e.focalChecksFailingAtFire)}</td>
                <td className="num">
                  {e.contextTokensAtFire === null ? '—' : tokens(e.contextTokensAtFire)}
                </td>
                <td className="num">
                  {e.cueDecision === null ? (
                    '—'
                  ) : (
                    <a onClick={() => select(e.cueDecision!)}>D{e.cueDecision}</a>
                  )}
                </td>
                <td className="num">
                  {e.contentDecision === null ? (
                    '—'
                  ) : (
                    <a onClick={() => select(e.contentDecision!)}>D{e.contentDecision}</a>
                  )}
                </td>
                <td className="num">{num(e.detectionLatency)}</td>
                <td>
                  {e.missed === null ? (
                    '—'
                  ) : e.missed ? (
                    <span className="status critical">✕ missed</span>
                  ) : (
                    'no'
                  )}
                </td>
                <td className="num">{num(e.focalChangesBeforeContent)}</td>
                <td className="num">{num(e.commitsBeforeContent)}</td>
                <td className="num">{num(e.toolActionsBeforeContent)}</td>
                <td>
                  {e.adapted === null ? (
                    '—'
                  ) : e.adapted ? (
                    <span className="status good">✓ correct</span>
                  ) : (
                    <span className="status serious">✕ wrong</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="kv-grid">
          <KeyValues title="Urgent work" values={g.urgent} />
          <KeyValues title="Outcome" values={g.outcome} />
          <KeyValues
            title="Validity"
            values={Object.fromEntries(g.validity.map((v) => [v.id, v.passed]))}
          />
        </div>
      </div>

      <Inspector run={run} rows={rows} decision={selected} onSelect={select} />
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function KeyValues({ title, values }: { title: string; values: Record<string, unknown> }) {
  return (
    <div>
      <h3>{title}</h3>
      <dl className="kv">
        {Object.entries(values).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{cell(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
