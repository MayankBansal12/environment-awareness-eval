/**
 * The run screen: a thin identity strip over one of two views of the same run.
 *
 * `cockpit` is the default — test cases, activity, terminal and Slack at once, on one
 * clock — because the ordinary question is "what did the model see and do here". `detail`
 * keeps the action-granular timeline and the artifact tabs for when the question is
 * "prove it", and both read the same bundle so they can never disagree.
 */

import { useMemo, useState } from 'react';
import { data } from '../data.js';
import { ticketDeliveryOf } from '../derive/metrics.js';
import type { RunBundle } from '../derive/model.js';
import { Cockpit } from './Cockpit.js';
import { RunDetail } from './RunDetail.js';

type Mode = 'cockpit' | 'detail';

interface Props {
  run: RunBundle;
  onBack: () => void;
  onSelectRun: (runId: string) => void;
}

export function RunScreen({ run, onBack, onSelectRun }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('cockpit');
  const model = run.summary.runtime.model;

  const models = useMemo(
    () => [...new Set(data.runs.map((entry) => entry.summary.runtime.model))].sort(),
    [],
  );
  const siblings = useMemo(
    () => data.runs.filter((entry) => entry.summary.runtime.model === model),
    [model],
  );

  // Switching model keeps the reader on the same condition where that is possible, so the
  // comparison they were making survives the switch instead of resetting to run one.
  const switchModel = (next: string): void => {
    const pool = data.runs.filter((entry) => entry.summary.runtime.model === next);
    const sameScenario = pool.find(
      (entry) =>
        entry.summary.scenarioId === run.summary.scenarioId &&
        ticketDeliveryOf(entry) === ticketDeliveryOf(run),
    );
    const target = sameScenario ?? pool[0];
    if (target !== undefined) onSelectRun(target.runId);
  };

  return (
    <>
      <div className="controls runstrip">
        <button onClick={onBack}>← runs</button>

        <label>
          model
          <select value={model} onChange={(event) => switchModel(event.target.value)}>
            {models.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>

        <span className="kv">
          <b>{run.runId}</b> · {run.summary.scenarioId} · ticket {ticketDeliveryOf(run)}
        </span>

        <div className="spacer" />

        <span className="nav">
          {(['cockpit', 'detail'] as const).map((entry) => (
            <button
              key={entry}
              className={mode === entry ? 'active' : ''}
              onClick={() => setMode(entry)}
            >
              {entry === 'cockpit' ? 'Behavior' : 'Evidence'}
            </button>
          ))}
        </span>
      </div>

      {mode === 'cockpit' ? (
        <>
          <Cockpit run={run} siblings={siblings} onSelectRun={onSelectRun} />
        </>
      ) : (
        <RunDetail run={run} />
      )}
    </>
  );
}
