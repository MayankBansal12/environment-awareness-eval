/** Original repeat-run rail, grouped by the native v4 condition and experiment. */
import type { RunRow } from '../model.js';
import { conditionLabel, TONE_GLYPH } from '../derive/metrics.js';
import { useRevealSelected } from './useRevealSelected.js';
import { prefetchRun } from '../data.js';
export function CaseRail({
  runs,
  selectedRunId,
  pendingRunId,
  onSelect,
}: {
  runs: readonly RunRow[];
  selectedRunId: string;
  pendingRunId?: string | undefined;
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
        Runs<span className="pane-note">{runs.length}</span>
      </h3>
      <div className="pane-body" ref={bodyRef}>
        {[...groups].map(([label, group]) => (
          <div className="railrow" key={label}>
            <div className="rail-scenario" title={label}>
              {group[0]!.condition.family}
              {([...groups.values()].filter(
                (g) => g[0]!.condition.family === group[0]!.condition.family,
              ).length > 1 ||
                group[0]!.experiment !== null) && (
                <span className="rail-condition">{label}</span>
              )}
            </div>
            <div className="rail-dots">
              {group.map((run, i) => {
                const tone =
                  !run.valid || run.censored || run.scenarioBehavior === 'unassessable'
                    ? 'invalid'
                    : run.importantMissed || run.scenarioBehavior === 'failed'
                      ? 'bad'
                      : 'good';
                return (
                  <button
                    key={run.key}
                    className={`raildot ${tone}${run.key === selectedRunId ? ' selected' : ''}${run.key === pendingRunId ? ' pending' : ''}`}
                    aria-current={run.key === selectedRunId ? 'true' : undefined}
                    title={run.key}
                    onClick={() => onSelect(run.key)}
                    onPointerEnter={() => prefetchRun(run.key)}
                    onFocus={() => prefetchRun(run.key)}
                  >
                    <span className="dot">{TONE_GLYPH[tone]}</span>
                    <span className="round-n">Run {i + 1}</span>
                    <span className="rail-outcome">
                      {!run.valid
                        ? 'Invalid'
                        : run.censored
                          ? 'Censored'
                          : run.scenarioBehavior
                            ? `Behavior ${run.scenarioBehavior}`
                            : `${run.importantMissed}/${run.importantFired} missed`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
