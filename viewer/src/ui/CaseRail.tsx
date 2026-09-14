/** Original repeat-run rail, grouped by the native v4 condition and experiment. */
import type { RunRow } from '../model.js';
import { conditionLabel, TONE_GLYPH } from '../derive/metrics.js';
import { useRevealSelected } from './useRevealSelected.js';
export function CaseRail({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: readonly RunRow[];
  selectedRunId: string;
  onSelect: (key: string) => void;
}) {
  const bodyRef = useRevealSelected('.raildot.selected', selectedRunId);
  const groups = new Map<string, RunRow[]>();
  for (const run of runs) {
    const key = `${run.experiment ?? 'dev'} · ${conditionLabel(run)}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return (
    <section className="pane railpane">
      <h3>
        test cases<span className="pane-note">{runs.length} runs</span>
      </h3>
      <div className="pane-body" ref={bodyRef}>
        {[...groups].map(([label, group]) => (
          <div className="railrow" key={label}>
            <div className="rail-scenario">{label}</div>
            <div className="rail-dots">
              {group.map((run, i) => {
                const tone =
                  !run.valid || run.censored
                    ? 'invalid'
                    : run.importantMissed
                      ? 'bad'
                      : 'good';
                return (
                  <button
                    key={run.key}
                    className={`raildot ${tone}${run.key === selectedRunId ? ' selected' : ''}`}
                    aria-current={run.key === selectedRunId ? 'true' : undefined}
                    title={run.key}
                    onClick={() => onSelect(run.key)}
                  >
                    <span className="dot">{TONE_GLYPH[tone]}</span>
                    <span className="round-n">Run {i + 1}</span>
                    <span className="rail-outcome">
                      {!run.valid
                        ? 'Invalid'
                        : run.censored
                          ? 'Censored'
                          : `${run.importantMissed}/${run.importantFired} missed`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="facts rail-legend">
        <div>● All fired updates retrieved</div>
        <div>× One or more updates missed</div>
        <div>◇ Invalid or censored</div>
      </div>
    </section>
  );
}
