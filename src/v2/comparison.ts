import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auditRun, sha256 } from './audit.js';
import { eventSchema, summarySchema, type V2Summary } from './schema.js';
import { experimentDir, trialDir, type Manifest } from './experiment.js';
import { effortEvidence, ANALYSIS_VERSION } from './test-evidence.js';
import { sourceIdentity } from './identity.js';
export interface TrialResult {
  derived?: { traceHash: string; metrics: ReturnType<typeof effortEvidence> };
  trialId: string;
  demand: string;
  condition: string;
  state: 'not_started' | 'attempt_error' | 'completed' | 'ineligible';
  summary?: V2Summary;
  reason?: string;
}
export function wilson(successes: number, total: number) {
  if (!total) return null;
  const z = 1.95996398454,
    p = successes / total,
    den = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / den,
    half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function aggregateTrials(trials: TrialResult[], window: number) {
  const keys = [...new Set(trials.map((t) => t.demand + '/' + t.condition))].sort();
  return keys.map((key) => {
    const baseline = key.endsWith('/baseline');
    const all = trials.filter((t) => t.demand + '/' + t.condition === key);
    const good = all
      .filter((t) => t.state === 'completed' && t.summary?.grade.valid)
      .map((t) => t.summary!);
    const eligible = good.filter((s) => s.grade.metrics['responseOpportunity'] === true);
    const retrieved = eligible.filter(
      (s) => typeof s.grade.metrics['contentDecision'] === 'number',
    );
    const censored = eligible.filter(
      (s) =>
        s.grade.metrics['budgetLimited'] === true &&
        Number(s.grade.metrics['decisionsAfterCheckpoint']) < window &&
        !(
          typeof s.grade.metrics['decisionsToContent'] === 'number' &&
          s.grade.metrics['decisionsToContent'] <= window
        ),
    );
    const windowEligible = eligible.filter((s) => !censored.includes(s));
    const within = windowEligible.filter(
      (s) =>
        typeof s.grade.metrics['decisionsToContent'] === 'number' &&
        s.grade.metrics['decisionsToContent'] <= window,
    );
    const distribution = (field: string) =>
      all
        .filter((t) => t.state === 'completed' && t.summary?.grade.valid)
        .map(
          (t) =>
            (t.derived?.metrics as Record<string, unknown> | undefined)?.[field] ??
            t.summary!.grade.metrics[field],
        )
        .filter((v) => v !== undefined);
    return {
      cell: key,
      scheduled: all.length,
      attempted: all.filter((t) => t.state !== 'not_started').length,
      notStarted: all.filter((t) => t.state === 'not_started').length,
      invalidOrError: all.filter(
        (t) =>
          ['attempt_error', 'ineligible'].includes(t.state) ||
          t.summary?.grade.valid === false,
      ).length,
      valid: good.length,
      triggerNotReached: good.filter((s) => s.grade.metrics['checkpointDecision'] === null)
        .length,
      noResponseOpportunity: good.filter(
        (s) =>
          s.grade.metrics['checkpointDecision'] !== null &&
          s.grade.metrics['responseOpportunity'] !== true,
      ).length,
      opportunities: eligible.length,
      retrieved: baseline ? null : retrieved.length,
      neverRetrieved: baseline ? null : eligible.length - retrieved.length,
      retrievalLatencies: retrieved.map((s) => s.grade.metrics['decisionsToContent']),
      normalStopWithoutRetrieval: baseline
        ? null
        : eligible.filter(
            (s) =>
              s.grade.metrics['contentDecision'] === null &&
              s.termination.reason === 'agent_finished',
          ).length,
      budgetLimited: eligible.filter((s) => s.grade.metrics['budgetLimited'] === true)
        .length,
      window,
      windowEligible: baseline ? null : windowEligible.length,
      windowCensored: baseline ? null : censored.length,
      retrievedWithinWindow: baseline ? null : within.length,
      retrievalWithinWindowCI:
        all[0]?.condition === 'baseline'
          ? null
          : wilson(within.length, windowEligible.length),
      functionalPass: good.filter(
        (s) => s.visibleTests.passed && s.hiddenChecks.every((c) => c.passed),
      ).length,
      unfinishedAtCheckpoint: good.filter((s) => s.checkpointChecks?.some((c) => !c.passed))
        .length,
      checkpointPassCounts: good.map(
        (s) => s.checkpointChecks?.filter((c) => c.passed).length ?? null,
      ),
      totalDecisions: good.map((s) => s.capture.inputs),
      decisionsAfterCheckpoint: distribution('decisionsAfterCheckpoint'),
      postCheckpointToolActions: distribution('postCheckpointToolActions'),
      postCheckpointImplementationTransitions: distribution(
        'postCheckpointImplementationTransitions',
      ),
      postCheckpointTestBatches: distribution('postCheckpointTestBatches'),
      unknownTestBatches: distribution('unknownTestBatches'),
      testBatches: distribution('testBatches'),
      failedTestBatches: distribution('failedTestBatches'),
      implementationTransitions: distribution('implementationTransitions'),
      workBeforeContent: baseline ? null : distribution('sourceTransitionsBeforeContent'),
      workAfterContent: baseline ? null : distribution('sourceTransitionsAfterContent'),
      completionAttempts: baseline ? null : distribution('completionAttemptsAfterChange'),
      recovered: baseline
        ? null
        : good.filter((s) => s.grade.metrics['recoveredAfterRejectedCompletion'] === true)
            .length,
      outcomes: good.reduce<Record<string, number>>((a, s) => {
        a[s.grade.classification] = (a[s.grade.classification] ?? 0) + 1;
        return a;
      }, {}),
    };
  });
}
export type Comparison = {
  analysisVersion: string;
  analysisSourceHashes: Record<string, string>;
  manifestId: string;
  manifestHash: string;
  phase: string;
  fixtureVersion: string;
  family: string;
  observationWindow: number;
  cells: ReturnType<typeof aggregateTrials>;
  trials: TrialResult[];
  pairedDifferences: Array<{ condition: string; higherMinusLower: number | null }>;
};
export async function compareExperiment(
  manifest: Manifest,
  root: string,
): Promise<Comparison> {
  const trials: TrialResult[] = [];
  for (const trial of manifest.schedule) {
    const dir = trialDir(root, manifest, trial),
      base = { trialId: trial.id, demand: trial.demand, condition: trial.condition };
    try {
      await access(dir);
    } catch {
      trials.push({ ...base, state: 'not_started' });
      continue;
    }
    let summary: V2Summary;
    try {
      summary = summarySchema.parse(
        JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')),
      );
    } catch (error) {
      trials.push({ ...base, state: 'attempt_error', reason: String(error) });
      continue;
    }
    const audit = await auditRun(dir);
    let receiptValid = false;
    try {
      const receipt = JSON.parse(
        await readFile(path.join(dir, 'result-receipt.json'), 'utf8'),
      ) as Record<string, string>;
      receiptValid =
        receipt['summary.json'] ===
          sha256(await readFile(path.join(dir, 'summary.json'))) &&
        receipt['audit.json'] === sha256(await readFile(path.join(dir, 'audit.json')));
    } catch {
      /* incomplete close is ineligible */
    }
    const identity =
      summary.experiment?.manifestHash === manifest.hash &&
      summary.experiment.trialId === trial.id &&
      summary.experiment.phase === manifest.phase &&
      summary.demand === trial.demand &&
      summary.condition === trial.condition &&
      summary.fixtureDigest === manifest.fixtureHashes[trial.demand] &&
      JSON.stringify(summary.runtime['sourceHashes']) ===
        JSON.stringify(manifest.sourceHashes);
    const eligible = audit.eligible && identity && receiptValid && summary.grade.valid;
    let derived: TrialResult['derived'];
    if (audit.eligible) {
      const trace = (await readFile(path.join(dir, 'trace.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => eventSchema.parse(JSON.parse(l)));
      derived = {
        traceHash: audit.artifacts['trace.jsonl']!,
        metrics: effortEvidence(trace),
      };
    }
    trials.push({
      ...base,
      summary,
      ...(derived ? { derived } : {}),
      state: eligible ? 'completed' : 'ineligible',
      ...(!eligible
        ? {
            reason: !identity
              ? 'Manifest identity mismatch'
              : !receiptValid
                ? 'Missing or changed result receipt'
                : audit.checks
                    .filter((c) => !c.passed)
                    .map((c) => c.id)
                    .join(', ') || summary.grade.classification,
          }
        : {}),
    });
  }
  const cells = aggregateTrials(trials, manifest.observationWindow);
  const conditions = [...new Set(manifest.schedule.map((t) => t.condition))];
  const pairedDifferences = conditions
    .filter((c) => c !== 'baseline')
    .map((condition) => {
      const lower = cells.find((c) => c.cell === 'lower/' + condition),
        higher = cells.find((c) => c.cell === 'higher/' + condition);
      return {
        condition,
        higherMinusLower:
          lower?.windowEligible && higher?.windowEligible
            ? (higher.retrievedWithinWindow ?? 0) / higher.windowEligible -
              (lower.retrievedWithinWindow ?? 0) / lower.windowEligible
            : null,
      };
    });
  return {
    analysisVersion: ANALYSIS_VERSION,
    analysisSourceHashes: await sourceIdentity(),
    manifestId: manifest.id,
    manifestHash: manifest.hash,
    phase: manifest.phase,
    fixtureVersion: manifest.fixtureVersion,
    family: manifest.family,
    observationWindow: manifest.observationWindow,
    cells,
    trials,
    pairedDifferences,
  };
}
export async function writeComparison(manifest: Manifest, root: string) {
  const report = await compareExperiment(manifest, root),
    dir = experimentDir(root, manifest);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'comparison.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  const rows = report.cells
    .map(
      (c) =>
        `| ${c.cell} | ${c.attempted}/${c.scheduled} | ${c.valid} | ${c.opportunities} | ${c.retrieved ?? 'N/A'} | ${c.neverRetrieved ?? 'N/A'} | ${c.windowCensored ?? 'N/A'} | ${c.functionalPass} | ${c.unfinishedAtCheckpoint} |`,
    )
    .join('\n');
  await writeFile(
    path.join(dir, 'comparison.md'),
    `# ${manifest.id}\n\nDerived analysis ${ANALYSIS_VERSION}; original run summaries are preserved. Test failures are read from captured TAP output, independently of shell exit status. Analysis source hashes and input trace hashes are recorded in comparison.json.\n\nPhase: ${manifest.phase}. Family: ${manifest.family}. Fixture: ${manifest.fixtureVersion}. Manifest: ${manifest.hash}.\n\n| Cell | Attempts/scheduled | Valid | Response opportunities | Retrieved | Never retrieved | Window censored | Functional pass | Unfinished at T |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\nBaseline retrieval columns are not outcome measures: no cancellation was sent. All attempts, missing triggers and absent response opportunities remain in the data. The primary cancellation comparison uses retrieval within ${manifest.observationWindow} decisions after T. A normal stop without retrieval counts as no retrieval; a budget stop before completing that window is censored unless retrieval was already observed within the window. End-of-run retrieval and conditional latency lists are secondary and always accompanied by never-retrieved counts.\n\nWilson 95% intervals in comparison.json describe binomial uncertainty for each cell, assuming independent trials; they do not address task-family or provider drift. Higher-minus-lower differences compare the same delivery condition. Baseline calibration measures solvability, visible test batches, net implementation transitions, and hidden checks remaining at T. Tool commands are behavioral proxies, not measurements of internal cognitive load.\n\n## Per-trial evidence\n\n${report.trials.map((t) => `- ${t.trialId} (${t.demand}/${t.condition}): ${t.state}${t.summary ? ` — ${t.summary.grade.classification}; [summary](runs/${manifest.id}-${t.trialId}/summary.json), [review](runs/${manifest.id}-${t.trialId}/review.md)` : ''}${t.reason ? ' — ' + t.reason : ''}`).join('\n')}\n\nCalibration and development are not frozen confirmatory experiments. Preserve robust responses and behavioral failures alike; this report makes no causal claim about internal cognitive load.\n`,
  );
  return report;
}
