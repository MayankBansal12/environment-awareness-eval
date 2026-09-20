import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { directExecutor, taskChecks } from './checks.js';
import { BASE_SPEC, type SpecFlags } from './families/types.js';
import { putFiles } from './fixture.js';
import { FAMILIES, familyFor, familySchema, loadSchema } from './scenario.js';

/** Every load fails exactly its injected bugs; references pass under every spec combination. */
export async function calibrate() {
  const specs: SpecFlags[] = [
    { requirementChange: false, commentChange: false },
    { requirementChange: true, commentChange: false },
    { requirementChange: false, commentChange: true },
    { requirementChange: true, commentChange: true },
  ];
  const results = [];
  let ok = true;
  for (const id of familySchema.options) {
    const family = FAMILIES[id];
    for (const load of loadSchema.options) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'calibrate-'));
      try {
        await putFiles(root, family.files(load));
        const executor = directExecutor(root);
        const broken = await taskChecks(executor, family, specs[0]!);
        const failing = broken.focal
          .filter((x) => !x.passed)
          .map((x) => x.id)
          .sort();
        const bugsMatch =
          JSON.stringify(failing) === JSON.stringify([...family.bugs[load]].sort());
        const hotfixBroken = broken.hotfix.some((x) => !x.passed);
        const references = [];
        for (const spec of specs) {
          await putFiles(root, family.reference(spec));
          const checks = await taskChecks(executor, family, spec);
          const stale = await taskChecks(executor, family, specs[0]!);
          const passesOwn = checks.focal.concat(checks.hotfix).every((x) => x.passed);
          const expectedStale = [
            ...(spec.requirementChange ? [family.checkIds.requirementChange] : []),
            ...(spec.commentChange ? [family.checkIds.comment] : []),
          ].sort();
          const staleFailing = stale.focal
            .filter((x) => !x.passed)
            .map((x) => x.id)
            .sort();
          const discriminates =
            JSON.stringify(staleFailing) === JSON.stringify(expectedStale);
          ok &&= passesOwn && discriminates;
          references.push({ spec, passesOwn, discriminates });
          await putFiles(root, family.files(load));
        }
        ok &&= bugsMatch && hotfixBroken;
        results.push({
          family: id,
          version: family.version,
          load,
          failing,
          bugsMatch,
          hotfixBroken,
          references,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  const delayed = [];
  for (const id of familySchema.options) {
    const family = familyFor({ family: id, scenario: 'delayed-relevance' });
    for (const load of loadSchema.options) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'calibrate-delayed-'));
      try {
        await putFiles(root, family.files(load));
        const executor = directExecutor(root);
        const stale = await taskChecks(executor, family, BASE_SPEC);
        await putFiles(root, family.reference(BASE_SPEC));
        const current = await taskChecks(executor, family, BASE_SPEC);
        const passes = current.focal.concat(current.hotfix).every((c) => c.passed);
        const discriminates =
          JSON.stringify(
            stale.hotfix
              .filter((c) => !c.passed)
              .map((c) => c.id)
              .sort(),
          ) === JSON.stringify(family.checkIds.hotfix.slice(0, 2).sort());
        ok &&= passes && discriminates;
        delayed.push({ cell: `${id}/${load}/delayed-relevance`, passes, discriminates });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  return {
    inference: false,
    ok,
    results,
    delayed,
    summary: results.map((r) => ({
      cell: `${r.family}/${r.load}`,
      injectedBugs: r.failing.length,
      bugsMatch: r.bugsMatch,
      references: r.references.every((x) => x.passesOwn && x.discriminates),
    })),
  };
}
