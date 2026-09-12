import type { Comparison } from '../../../src/v2/comparison.js';
export function Experiments({ experiments }: { experiments: Comparison[] }) {
  return (
    <>
      {experiments.map((e) => (
        <section key={e.manifestHash}>
          <h2>{e.manifestId}</h2>
          <p>
            {e.phase} · {e.family} · {e.fixtureVersion}. Retrieval window:{' '}
            {e.observationWindow} decisions after the checkpoint.
          </p>
          <p>
            Baseline runs measure task completion and work remaining. Cancellation
            comparisons include never-retrieved runs; incomplete observation windows are
            shown separately.
          </p>
          <table>
            <thead>
              <tr>
                <th>Demand / delivery</th>
                <th>Attempts / planned</th>
                <th>Valid</th>
                <th>No trigger / no opportunity</th>
                <th>Retrieved / opportunities</th>
                <th>Never retrieved</th>
                <th>Window censored</th>
                <th>Functional pass</th>
                <th>Unfinished at checkpoint</th>
              </tr>
            </thead>
            <tbody>
              {e.cells.map((c) => (
                <tr key={c.cell}>
                  <td>{c.cell}</td>
                  <td>
                    {c.attempted}/{c.scheduled}
                  </td>
                  <td>{c.valid}</td>
                  <td>
                    {c.triggerNotReached}/{c.noResponseOpportunity}
                  </td>
                  <td>
                    {c.cell.endsWith('/baseline')
                      ? 'N/A'
                      : `${c.retrieved}/${c.opportunities}`}
                  </td>
                  <td>{c.cell.endsWith('/baseline') ? 'N/A' : c.neverRetrieved}</td>
                  <td>{c.windowCensored ?? 'N/A'}</td>
                  <td>{c.functionalPass}</td>
                  <td>{c.unfinishedAtCheckpoint}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>
              Uncertainty, fixed-window comparisons, and all attempt statuses
            </summary>
            <pre>
              {JSON.stringify(
                {
                  cells: e.cells,
                  pairedDifferences: e.pairedDifferences,
                  trials: e.trials.map((t) => ({
                    trialId: t.trialId,
                    demand: t.demand,
                    condition: t.condition,
                    state: t.state,
                    reason: t.reason,
                  })),
                },
                null,
                2,
              )}
            </pre>
          </details>
          <p>
            Intervals describe sampling uncertainty within these tasks. They do not
            establish internal cognitive load or generalization to other task families.
            Status-report quality requires manual review.
          </p>
        </section>
      ))}
    </>
  );
}
