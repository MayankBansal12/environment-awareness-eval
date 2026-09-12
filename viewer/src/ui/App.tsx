import { useMemo, useState } from 'react';
import { data } from '../data.js';
import { Compare } from './Compare.js';
import { RunIndex } from './RunIndex.js';
import { RunScreen } from './RunScreen.js';
import { V2Runs } from './V2Runs.js';
import { V3Runs } from './V3Runs.js';
import { Experiments } from './Experiments.js';

export type Screen =
  | { name: 'index' }
  | { name: 'run'; runId: string }
  | { name: 'compare'; a: string | null; b: string | null };

export function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>({ name: 'index' });

  const runsById = useMemo(() => new Map(data.runs.map((run) => [run.runId, run])), []);

  return (
    // The cockpit puts four panes side by side, so the run screen is given the full
    // viewport width rather than the reading-width column the tables want.
    <div className={screen.name === 'run' ? 'app wide' : 'app'}>
      <div className="topbar">
        <h1>Environment awareness</h1>
        <div className="nav">
          <button
            className={screen.name === 'index' ? 'active' : ''}
            onClick={() => setScreen({ name: 'index' })}
          >
            Results
          </button>
          <button
            className={screen.name === 'compare' ? 'active' : ''}
            onClick={() => setScreen({ name: 'compare', a: null, b: null })}
          >
            Compare
          </button>
        </div>
        <div className="spacer" />
        <div className="meta">
          <details>
            <summary>Dataset info</summary>
            <div className="dataset-info">
              {data.runs.length + (data.v2Runs?.length ?? 0) + (data.v3Runs?.length ?? 0)}{' '}
              runs · {data.resultsDir}
              <br />
              Built {data.generatedAtIso.replace('T', ' ').slice(0, 16)}
            </div>
          </details>
        </div>
      </div>

      {data.warnings.length > 0 && (
        <div className="banner">
          <h3>ARTIFACT WARNINGS — {data.warnings.length}</h3>
          <ul>
            {data.warnings.map((warning, index) => (
              <li key={index}>
                <b>{warning.runId}</b> [{warning.kind}] {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div hidden={screen.name !== 'index'}>
        <Experiments experiments={data.experiments ?? []} />
        {(data.v3Runs?.length ?? 0) > 0 && <V3Runs runs={data.v3Runs!} />}
        {(data.v2Runs?.length ?? 0) > 0 && <V2Runs runs={data.v2Runs!} />}
        {(data.runs.length > 0 || (!data.v2Runs?.length && !data.v3Runs?.length)) && (
          <RunIndex
            onOpen={(runId) => setScreen({ name: 'run', runId })}
            onCompare={(a, b) => setScreen({ name: 'compare', a, b })}
          />
        )}
      </div>

      {screen.name === 'run' &&
        (() => {
          const run = runsById.get(screen.runId);
          if (run === undefined) return <p>Unknown run {screen.runId}</p>;
          return (
            <RunScreen
              key={run.runId}
              run={run}
              onBack={() => setScreen({ name: 'index' })}
              onSelectRun={(runId) => setScreen({ name: 'run', runId })}
            />
          );
        })()}

      {screen.name === 'compare' && <Compare initialA={screen.a} initialB={screen.b} />}
    </div>
  );
}
