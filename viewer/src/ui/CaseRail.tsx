/**
 * The test-case rail.
 *
 * One row per scenario, with repeats as dots rather than as rows — run-to-run variance
 * inside one condition is the first thing worth seeing, and stacking repeats vertically
 * hides it. The rail is filtered to one model at a time because comparing two models in
 * one column would put two different populations in the same shape.
 *
 * Ticket delivery splits a scenario into separate rows when a corpus contains both, since
 * a Slack-delivered and a directly-delivered ticket are different conditions, not repeats.
 */

import { classificationTone, groupRuns, TONE_GLYPH } from '../derive/metrics.js';
import { humanize, outcomeLabel } from './labels.js';
import type { RunBundle } from '../derive/model.js';

interface Props {
  runs: readonly RunBundle[];
  selectedRunId: string;
  onSelect: (runId: string) => void;
}

export function CaseRail({ runs, selectedRunId, onSelect }: Props): JSX.Element {
  const cells = groupRuns(runs);
  const showTicket = new Set(cells.map((cell) => cell.ticketDelivery)).size > 1;

  return (
    <section className="pane railpane">
      <h3>
        test cases
        <span className="pane-note">{runs.length} runs</span>
      </h3>

      <div className="pane-body">
        {cells.length === 0 && <p className="empty-note">No runs for this model.</p>}

        {cells.map((cell) => (
          <div className="railrow" key={`${cell.scenarioId}|${cell.ticketDelivery}`}>
            <div className="rail-scenario">
              {humanize(cell.scenarioId)}
              {showTicket && <span className="rail-ticket">{cell.ticketDelivery}</span>}
            </div>
            <div className="rail-dots">
              {cell.runs.map(({ round, run }) => {
                const tone = classificationTone(run);
                return (
                  <button
                    key={run.runId}
                    className={`raildot ${tone}${run.runId === selectedRunId ? ' selected' : ''}`}
                    aria-current={run.runId === selectedRunId ? 'true' : undefined}
                    title={run.runId}
                    onClick={() => onSelect(run.runId)}
                  >
                    <span className="dot">{TONE_GLYPH[tone]}</span>
                    <span className="round-n">Run {round}</span>
                    <span className="rail-outcome">
                      {outcomeLabel(run.summary.grade.classification)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="facts rail-legend">
        <div>
          <span className="raildot good">
            <span className="dot">{TONE_GLYPH.good}</span>
          </span>{' '}
          adapted immediately / task completed
        </div>
        <div>
          <span className="raildot delayed">
            <span className="dot">{TONE_GLYPH.delayed}</span>
          </span>{' '}
          adapted, but late
        </div>
        <div>
          <span className="raildot bad">
            <span className="dot">{TONE_GLYPH.bad}</span>
          </span>{' '}
          failed to integrate the update
        </div>
        <div>
          <span className="raildot invalid">
            <span className="dot">{TONE_GLYPH.invalid}</span>
          </span>{' '}
          invalid — excluded from aggregates
        </div>
      </div>
    </section>
  );
}
