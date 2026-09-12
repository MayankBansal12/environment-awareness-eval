import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunSandbox } from './sandbox.js';
import { prepareFixture, applyReference, FIXTURE_VERSION, TASK_FAMILY } from './fixture.js';
import { functionalChecks } from './checks.js';
async function main() {
  const file = process.argv[2];
  if (!file) throw Error('Supply an output JSON path (exclusive create)');
  const variants = [];
  for (const demand of ['lower', 'higher'] as const) {
    const sandbox = await RunSandbox.create();
    try {
      const fixture = await prepareFixture(sandbox, demand),
        broken = await functionalChecks(sandbox);
      await applyReference(sandbox, demand, true);
      const serviceAndStore = await functionalChecks(sandbox);
      await applyReference(sandbox, demand);
      const complete = await functionalChecks(sandbox);
      if (
        broken.hiddenChecks.every((c) => c.passed) ||
        serviceAndStore.hiddenChecks.every((c) => c.passed) ||
        !complete.hiddenChecks.every((c) => c.passed) ||
        !complete.visibleTests.passed
      )
        throw Error('Reference calibration failed for ' + demand);
      variants.push({ demand, fixture, broken, serviceAndStore, complete });
    } finally {
      await sandbox.dispose();
    }
  }
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      { fixtureVersion: FIXTURE_VERSION, family: TASK_FAMILY, inference: false, variants },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      file,
      inference: false,
      variants: variants.map((v) => ({
        demand: v.demand,
        brokenPasses: v.broken.hiddenChecks.filter((c) => c.passed).length,
        partialPasses: v.serviceAndStore.hiddenChecks.filter((c) => c.passed).length,
        completePasses: v.complete.hiddenChecks.filter((c) => c.passed).length,
      })),
    }),
  );
}
main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
