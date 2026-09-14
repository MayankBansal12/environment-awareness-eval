import { useEffect, useRef, useState } from 'react';
import type { EventMetrics } from '../../../src/schema.js';
import { importantKinds, KIND_LABEL, type DecisionRow } from '../derive.js';
import { tokens, usd } from '../format.js';

const GUTTER = 132;
const LANES = [
  { id: 'updates', label: 'Updates', height: 30 },
  ...importantKinds.map((k) => ({ id: k, label: KIND_LABEL[k], height: 16 })),
  { id: 'linear', label: 'Linear unread', height: 26 },
  { id: 'slack', label: 'Slack unread', height: 26 },
  { id: 'focal', label: 'Focal edit', height: 14 },
  { id: 'hotfix', label: 'Hotfix edit', height: 14 },
  { id: 'commit', label: 'Commit', height: 14 },
  { id: 'test', label: 'Test failure', height: 14 },
  { id: 'runtime', label: 'Retry · compaction', height: 16 },
  { id: 'tokens', label: 'Tokens, cumulative', height: 40 },
  { id: 'cost', label: 'Cost, cumulative', height: 40 },
] as const;
type LaneId = (typeof LANES)[number]['id'];
const top: Record<string, number> = {};
let y = 6;
for (const lane of LANES) {
  top[lane.id] = y;
  y += lane.height + 6;
}
const HEIGHT = y + 18;
const laneOf = (id: LaneId) => ({ y: top[id]!, h: LANES.find((l) => l.id === id)!.height });

export function Timeline({
  rows,
  metrics,
  selected,
  onSelect,
}: {
  rows: DecisionRow[];
  metrics: EventMetrics[];
  selected: number;
  onSelect: (decision: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const n = rows.length || 1;
  const col = Math.min(36, Math.max(9, (width - 70) / n));
  const plotWidth = col * n;
  const x = (d: number) => (d - 1) * col + col / 2;
  const maxUnread = Math.max(1, ...rows.flatMap((r) => [r.unread.linear, r.unread.slack]));
  const last = rows.at(-1);
  const maxTokens = Math.max(1, last?.cumulativeTokens ?? 1);
  const maxCost = Math.max(1e-9, last?.cumulativeCostUsd ?? 0);
  const line = (value: (r: DecisionRow) => number, max: number, lane: LaneId) => {
    const { y: ly, h } = laneOf(lane);
    return rows.map((r) => `${x(r.decision)},${ly + h - (value(r) / max) * h}`).join(' ');
  };
  const hovered = hover === null ? null : rows[hover - 1];

  return (
    <div className="timeline" onMouseLeave={() => setHover(null)}>
      <svg className="lane-labels" width={GUTTER} height={HEIGHT} aria-hidden>
        {LANES.map((lane) => (
          <g key={lane.id} transform={`translate(0 ${top[lane.id]! + lane.height / 2})`}>
            {importantKinds.includes(lane.id as never) && (
              <rect
                x={4}
                y={-4}
                width={8}
                height={8}
                rx={2}
                className={`fill-${lane.id}`}
              />
            )}
            <text x={importantKinds.includes(lane.id as never) ? 16 : 4} dy="0.35em">
              {lane.label}
            </text>
          </g>
        ))}
      </svg>
      <div className="plot" ref={box}>
        <svg
          width={plotWidth + 64}
          height={HEIGHT}
          role="img"
          aria-label="Decision timeline"
          onMouseMove={(e) => {
            const left = e.currentTarget.getBoundingClientRect().left;
            const d = Math.floor((e.clientX - left) / col) + 1;
            setHover(d >= 1 && d <= n ? d : null);
          }}
          onClick={() => hover && onSelect(hover)}
        >
          {LANES.map((lane) => (
            <line
              key={lane.id}
              className="lane-base"
              x1={0}
              x2={plotWidth}
              y1={top[lane.id]! + lane.height}
              y2={top[lane.id]! + lane.height}
            />
          ))}
          <rect
            className="cursor"
            x={(selected - 1) * col}
            y={0}
            width={col}
            height={HEIGHT - 16}
          />
          {hover !== null && (
            <rect
              className="hover"
              x={(hover - 1) * col}
              y={0}
              width={col}
              height={HEIGHT - 16}
            />
          )}
          {rows.map((r) => {
            const cx = x(r.decision);
            const updates = laneOf('updates');
            const important = r.fired.filter((f) => f.kind !== 'noise');
            const noise = r.fired.filter((f) => f.kind === 'noise');
            const bar = (lane: 'linear' | 'slack', v: number) => {
              const { y: ly, h } = laneOf(lane);
              const bh = (v / maxUnread) * h;
              return v ? (
                <rect
                  className={`bar-${lane}`}
                  x={cx - col * 0.3}
                  y={ly + h - bh}
                  width={col * 0.6}
                  height={bh}
                  rx={1.5}
                />
              ) : null;
            };
            const tick = (lane: LaneId, on: boolean, cls: string, glyph?: string) => {
              if (!on) return null;
              const { y: ly, h } = laneOf(lane);
              return glyph ? (
                <text className={cls} x={cx} y={ly + h / 2} dy="0.35em" textAnchor="middle">
                  {glyph}
                </text>
              ) : (
                <rect
                  className={cls}
                  x={cx - 3.5}
                  y={ly + h / 2 - 3.5}
                  width={7}
                  height={7}
                  rx={1.5}
                />
              );
            };
            return (
              <g key={r.decision}>
                {important.map((f, i) => (
                  <path
                    key={f.eventId}
                    className={`fill-${f.kind} ring`}
                    d={`M${cx} ${updates.y + 2 + i * 4} l6 7 l-6 7 l-6 -7z`}
                  />
                ))}
                {noise.map((f, i) => (
                  <rect
                    key={f.eventId}
                    className="noise"
                    x={cx - 1}
                    y={updates.y + updates.h - 8 - i * 3}
                    width={2}
                    height={8}
                  />
                ))}
                {bar('linear', r.unread.linear)}
                {bar('slack', r.unread.slack)}
                {tick('focal', r.focalEdit, 'work-focal')}
                {tick('hotfix', r.hotfixEdit, 'work-hotfix')}
                {tick('commit', r.commits > 0, 'work-commit', '●')}
                {tick('test', r.testFailure, 'work-test', '✕')}
                {tick('runtime', r.retries > 0, 'rt-retry', '↻')}
                {tick('runtime', r.compaction, 'rt-compaction', '⇲')}
              </g>
            );
          })}
          {metrics
            .filter((m) => m.fired && m.firedDecision !== null)
            .map((m) => {
              const { y: ly, h } = laneOf(m.kind);
              const cy = ly + h / 2;
              const end = m.contentDecision ?? last?.decision ?? m.firedDecision!;
              return (
                <g key={m.kind}>
                  <line
                    className={`stroke-${m.kind}${m.missed ? ' missed' : ''}`}
                    x1={x(m.firedDecision!)}
                    x2={x(end)}
                    y1={cy}
                    y2={cy}
                  />
                  <path
                    className={`fill-${m.kind} ring`}
                    d={`M${x(m.firedDecision!)} ${cy - 5} l5 5 l-5 5 l-5 -5z`}
                  />
                  {m.cueDecision !== null && (
                    <circle
                      className={`cue stroke-${m.kind}`}
                      cx={x(m.cueDecision)}
                      cy={cy}
                      r={4.5}
                    />
                  )}
                  {m.contentDecision !== null && (
                    <circle
                      className={`fill-${m.kind} ring`}
                      cx={x(m.contentDecision)}
                      cy={cy}
                      r={4.5}
                    />
                  )}
                  {m.missed && (
                    <text className="missed-label" x={x(end) + 8} y={cy} dy="0.35em">
                      missed
                    </text>
                  )}
                </g>
              );
            })}
          <polyline
            className="series"
            points={line((r) => r.cumulativeTokens, maxTokens, 'tokens')}
          />
          <polyline
            className="series"
            points={line((r) => r.cumulativeCostUsd, maxCost, 'cost')}
          />
          <text className="axis" x={plotWidth + 6} y={laneOf('tokens').y} dy="0.35em">
            {tokens(maxTokens)}
          </text>
          <text className="axis" x={plotWidth + 6} y={laneOf('cost').y} dy="0.35em">
            {usd(maxCost)}
          </text>
          {rows
            .filter((r) => r.decision === 1 || r.decision % (col < 14 ? 10 : 5) === 0)
            .map((r) => (
              <text
                key={r.decision}
                className="axis"
                x={x(r.decision)}
                y={HEIGHT - 4}
                textAnchor="middle"
              >
                D{r.decision}
              </text>
            ))}
        </svg>
        {hovered && (
          <div
            className="tooltip"
            style={{
              left: Math.min(x(hovered.decision) + 14, Math.max(0, plotWidth - 260)),
            }}
          >
            <b>Decision {hovered.decision}</b> · {hovered.stopReason}
            <div>
              Unread: Linear {hovered.unread.linear} · Slack {hovered.unread.slack}
            </div>
            {hovered.actions.length > 0 && (
              <div>Tools: {hovered.actions.map((a) => a.name).join(', ')}</div>
            )}
            {hovered.fired.map((f) => (
              <div key={f.eventId}>
                {f.kind === 'noise' ? 'Noise' : KIND_LABEL[f.kind]} fired ({f.trigger}
                {f.duringTestFailure ? ', during test failure' : ''})
              </div>
            ))}
            {hovered.exposures.map((e) => (
              <div key={e.eventId + e.level}>
                {KIND_LABEL[e.kind]} {e.level} via {e.via}
              </div>
            ))}
            {hovered.retries > 0 && <div>{hovered.retries} provider retries</div>}
            {hovered.compaction && <div>Compaction</div>}
            <div className="muted">
              {tokens(hovered.tokens)} tokens · {usd(hovered.costUsd)} · cumulative{' '}
              {tokens(hovered.cumulativeTokens)} / {usd(hovered.cumulativeCostUsd)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
