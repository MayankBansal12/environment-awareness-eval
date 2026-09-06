/**
 * Screen 2 — the run detail. Header, timeline, context panel, artifact tabs.
 */

import { useMemo, useState } from 'react';
import type { ActionRow, MarkerRow, RunBundle } from '../derive/model.js';
import {
  actionRowsOf,
  buildDigest,
  markerRowsOf,
  workspaceStateByDecision,
} from '../derive/timeline.js';
import { DiffView, FinalReportView, GatesView, ReportView } from './Artifacts.js';
import { ContextPanel } from './ContextPanel.js';
import { RunHeader } from './RunHeader.js';
import { Timeline, type Zoom } from './Timeline.js';

type ArtifactTab = 'timeline' | 'final' | 'diff' | 'report' | 'gates';

export function RunDetail({
  run,
  onBack,
}: {
  run: RunBundle;
  onBack: () => void;
}): JSX.Element {
  const [zoom, setZoom] = useState<Zoom>('digest');
  const [tab, setTab] = useState<ArtifactTab>('timeline');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<ActionRow | MarkerRow | null>(null);

  const actions = useMemo(() => actionRowsOf(run), [run]);
  const markers = useMemo(() => markerRowsOf(run.trace), [run]);
  const states = useMemo(() => workspaceStateByDecision(run.trace), [run]);

  const digestRows = useMemo(() => buildDigest(actions, markers), [actions, markers]);
  // At `actions` and `raw` zoom every call is its own row, so no banding is applied.
  const flatRows = useMemo(
    () => [...actions, ...markers].sort((a, b) => a.seq - b.seq),
    [actions, markers],
  );
  const rows = zoom === 'digest' ? digestRows : flatRows;

  const indicatorSeq =
    markers.find((marker) => marker.marker === 'indicator')?.seq ?? null;
  const contentSeq =
    markers.find((marker) => marker.marker === 'content' || marker.marker === 'steer')
      ?.seq ?? null;

  return (
    <>
      <div className="controls">
        <button onClick={onBack}>← runs</button>
        <div className="spacer" />
        <label>
          zoom
          <span className="nav">
            {(['digest', 'actions', 'raw'] as const).map((level) => (
              <button
                key={level}
                className={zoom === level ? 'active' : ''}
                onClick={() => setZoom(level)}
              >
                {zoom === level ? '● ' : '○ '}
                {level}
              </button>
            ))}
          </span>
        </label>
      </div>

      <RunHeader run={run} />

      <div className="controls">
        {(
          [
            ['timeline', 'timeline'],
            ['final', 'final report'],
            ['diff', 'workspace.diff'],
            ['report', 'report.md'],
            ['gates', 'gates & checks'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'timeline' ? (
        <div className="split">
          <Timeline
            rows={rows}
            zoom={zoom}
            states={states}
            expanded={expanded}
            onToggleBand={(key) =>
              setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            selectedSeq={selected?.seq ?? null}
            onSelect={setSelected}
            indicatorSeq={indicatorSeq}
            contentSeq={contentSeq}
          />
          <ContextPanel run={run} selected={selected} />
        </div>
      ) : (
        <div className="timeline">
          {tab === 'final' && <FinalReportView run={run} />}
          {tab === 'diff' && <DiffView run={run} />}
          {tab === 'report' && <ReportView run={run} />}
          {tab === 'gates' && <GatesView run={run} />}
        </div>
      )}
    </>
  );
}
