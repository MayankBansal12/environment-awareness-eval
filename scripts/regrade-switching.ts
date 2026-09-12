/** Offline correction pass. No model runtime is created and original artifacts stay intact. */
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunSandbox } from '../src/v2/sandbox.js';
import { sha256 } from '../src/v2/audit.js';
import { sourceIdentity } from '../src/v2/identity.js';
import { auditRun } from '../src/v3/audit.js';
import { snapshot } from '../src/v3/engine.js';
import { functionalChecks } from '../src/v3/checks.js';
import { grade, GRADER_VERSION } from '../src/v3/grader.js';
import type { Summary, Event } from '../src/v3/schema.js';

async function main() {
  if (String(GRADER_VERSION) !== '3.0.1')
    throw Error(
      'Historical 3.0.1 analysis requires its frozen source snapshot. Refusing to label a newer grader as analysis-v301.',
    );
  const root = process.argv[2];
  if (!root) throw Error('Supply a completed experiment directory');
  const sources = await sourceIdentity();
  for (const entry of (await readdir(path.join(root, 'runs'))).sort()) {
    const dir = path.join(root, 'runs', entry);
    const original = await readFile(path.join(dir, 'summary.json'), 'utf8');
    const summary = JSON.parse(original) as Summary;
    const audit = await auditRun(dir);
    if (!audit.eligible) throw Error('Cannot regrade incomplete evidence: ' + dir);
    const trace = (await readFile(path.join(dir, 'trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Event);
    const revision = trace.find(
      (e) => e.type === 'environment_event' && e.event.kind === 'revision',
    );
    async function checksAt(source: string, decision: number, final = false) {
      const sandbox = await RunSandbox.create();
      try {
        await cp(source, sandbox.repo, {
          recursive: true,
          dereference: false,
          filter: (p) => path.basename(p) !== 'node_modules',
        });
        if (
          final &&
          (await snapshot(sandbox, 'HEAD')).digest !== summary.finalWorkspace.digest
        )
          throw Error('Retained final repository has changed: ' + dir);
        return await functionalChecks(
          sandbox,
          Boolean(revision && revision.decision <= decision),
        );
      } finally {
        await sandbox.dispose();
      }
    }
    const evidence = structuredClone(summary.evidence);
    const checkpoint = trace.find((e) => e.type === 'checkpoint');
    if (checkpoint)
      evidence.checkpoint = await checksAt(
        path.join(dir, 'checkpoint-repo'),
        checkpoint.decision,
      );
    for (const m of evidence.milestones)
      m.checks = await checksAt(
        path.join(dir, m.kind === 'A_done' ? 'feature-done-repo' : 'urgent-done-repo'),
        m.decision,
      );
    if (!summary.retainedWorkspace)
      throw Error('Final workspace required for revised acceptance probes');
    evidence.final = await checksAt(summary.retainedWorkspace, Infinity, true);
    const corrected = grade(
      trace,
      audit,
      evidence,
      summary.team,
      summary.finalWorkspace,
      summary.termination.reason,
      summary.sequence,
    );
    const analysis = {
      analysisVersion: '3.0.1',
      createdAt: new Date().toISOString(),
      inference: false,
      originalSummarySha256: sha256(original),
      originalIntegritySha256: sha256(await readFile(path.join(dir, 'integrity.json'))),
      analysisScriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      sourceHashes: sources,
      note: 'Post-calibration corrections: distinguish reports from resumption actions; reject explicit null status; verify completed retries do not re-finalize. Original initial probes/visible tests remain frozen; checkpoint, completion and final hidden probes are rerun in private sandboxes. Original grades are unchanged.',
      grade: corrected,
      evidence,
    };
    await writeFile(
      path.join(dir, 'analysis-v301.json'),
      JSON.stringify(analysis, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        run: entry,
        original: summary.grade.outcome,
        corrected: corrected.outcome,
        resumption: corrected.metrics['resumptionDecision'],
        failedFinal: [...evidence.final.A, ...evidence.final.B].filter((c) => !c.passed),
      }),
    );
  }
}
main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
