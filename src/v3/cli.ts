import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunSandbox } from '../v2/sandbox.js';
import { freeRuntime } from '../v2/model.js';
import { prepareFixture, applyReference } from './fixture.js';
import { functionalChecks } from './checks.js';
import { freeze, execute, compare, profileSchema } from './experiment.js';
import { auditRun } from './audit.js';

async function main() {
  const [command, file, arg, profile, seed] = process.argv.slice(2);
  if (command === 'verify-model') {
    console.log(JSON.stringify((await freeRuntime()).verification, null, 2));
    return;
  }
  if (command === 'reference') {
    if (!file) throw Error('Provide exclusive output file');
    const variants = [];
    for (const demand of ['lower', 'higher'] as const) {
      const s = await RunSandbox.create();
      try {
        const fixture = await prepareFixture(s, demand),
          broken = await functionalChecks(s);
        await applyReference(s, 'A');
        const featureOnly = await functionalChecks(s);
        await applyReference(s, 'B');
        const complete = await functionalChecks(s);
        await applyReference(s, 'A', true);
        const revised = await functionalChecks(s, true);
        if (
          broken.A.every((c) => c.passed) ||
          broken.B.every((c) => c.passed) ||
          !featureOnly.A.every((c) => c.passed) ||
          featureOnly.B.every((c) => c.passed) ||
          !complete.A.concat(complete.B, revised.A, revised.B).every((c) => c.passed)
        )
          throw Error('Reference calibration failed');
        variants.push({ demand, fixture, broken, featureOnly, complete, revised });
      } finally {
        await s.dispose();
      }
    }
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, JSON.stringify({ inference: false, variants }, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(file);
    return;
  }
  if (command === 'freeze' && file && arg) {
    console.log(
      JSON.stringify(
        await freeze(
          file,
          arg,
          profileSchema.parse(profile ?? 'switching-pilot'),
          Number(seed ?? 0),
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'execute' && file) {
    console.log(JSON.stringify(await execute(file, 'results', Number(arg ?? 1)), null, 2));
    return;
  }
  if (command === 'compare' && file) {
    console.log(JSON.stringify(await compare(file, 'results'), null, 2));
    return;
  }
  if (command === 'audit' && file) {
    const audit = await auditRun(file);
    console.log(JSON.stringify(audit, null, 2));
    if (!audit.eligible) process.exitCode = 1;
    return;
  }
  console.log(
    'pnpm eval:v3 verify-model | reference <output.json> | freeze <manifest.json> <id> [switching-pilot|matched-revision|demand-baseline] [seed] | execute <manifest.json> [1..3] | compare <manifest.json> | audit <run-dir>',
  );
}
main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
