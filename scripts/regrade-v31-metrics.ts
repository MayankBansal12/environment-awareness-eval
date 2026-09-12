/** Offline metric correction; does not create a model runtime or change original records. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRun } from '../src/v3/audit.js';
import { grade, GRADER_VERSION } from '../src/v3/grader.js';
import { sourceIdentity } from '../src/v2/identity.js';
import { sha256 } from '../src/v2/audit.js';
import type { Summary, Event } from '../src/v3/schema.js';

async function main() {
  if (String(GRADER_VERSION) !== '3.1.1')
    throw Error('This correction requires grader 3.1.1');
  const root = process.argv[2];
  if (!root) throw Error('Supply a completed 3.1 experiment directory');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
    trials: Array<{ id: string }>;
  };
  const sources = await sourceIdentity();
  const plans = [];
  // Validate every run before writing any corrected analysis.
  for (const trial of manifest.trials) {
    const dir = path.join(root, 'runs', trial.id),
      raw = await readFile(path.join(dir, 'summary.json'), 'utf8');
    const summary = JSON.parse(raw) as Summary;
    if (
      summary.runtime['protocolVersion'] !== '3.1' ||
      summary.grade.metrics['graderVersion'] !== '3.1.0'
    )
      throw Error('Only original 3.1.0 runs are eligible for this correction');
    const receipt = JSON.parse(
      await readFile(path.join(dir, 'result-receipt.json'), 'utf8'),
    ) as Record<string, string>;
    for (const name of ['summary.json', 'audit.json', 'integrity.json'])
      if (sha256(await readFile(path.join(dir, name))) !== receipt[name])
        throw Error('Original receipt mismatch');
    const audit = await auditRun(dir);
    if (!audit.eligible) throw Error('Cannot correct ineligible evidence: ' + trial.id);
    const trace = (await readFile(path.join(dir, 'trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Event);
    const corrected = grade(
      trace,
      audit,
      summary.evidence,
      summary.team,
      summary.finalWorkspace,
      summary.termination.reason,
      summary.sequence,
    );
    if (
      corrected.outcome !== summary.grade.outcome ||
      JSON.stringify(corrected.gates) !== JSON.stringify(summary.grade.gates)
    )
      throw Error('This metric correction unexpectedly changes a workflow gate');
    plans.push({
      dir,
      analysis: {
        analysisVersion: GRADER_VERSION,
        createdAt: new Date().toISOString(),
        inference: false,
        originalSummarySha256: sha256(raw),
        originalIntegritySha256: receipt['integrity.json'],
        analysisScriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
        sourceHashes: sources,
        note: 'Metric correction only: recognize root-level get_ticket fields as well as nested status-response tickets; count visible TAP failures even when a pipeline omits the final summary, and distinguish failures after an urgent source change. Original gates, acceptance probes and behavioral outcomes remain unchanged. No inference or private probes rerun.',
        grade: corrected,
        evidence: summary.evidence,
      },
    });
  }
  for (const { dir, analysis } of plans) {
    await writeFile(
      path.join(dir, 'analysis-v311.json'),
      JSON.stringify(analysis, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        run: path.basename(dir),
        outcome: analysis.grade.outcome,
        fullTicket: analysis.grade.metrics['firstFullAssignmentContent'],
        urgentDecisions: analysis.grade.metrics['urgentWorkDecisions'],
      }),
    );
  }
}
main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
