import { describe, it, expect } from 'vitest';
import { RunSandbox } from '../src/v2/sandbox.js';
import { prepareFixture, applyReference, putFiles } from '../src/v3/fixture.js';
import { functionalChecks } from '../src/v3/checks.js';
describe('feature and independent gateway recovery', () => {
  for (const demand of ['lower', 'higher'] as const)
    it(demand + ' reference and negative controls', async () => {
      const s = await RunSandbox.create();
      try {
        await prepareFixture(s, demand);
        const broken = await functionalChecks(s);
        expect(broken.A.some((c) => !c.passed)).toBe(true);
        expect(broken.B.some((c) => !c.passed)).toBe(true);
        await applyReference(s, 'A');
        const feature = await functionalChecks(s);
        expect(feature.A.every((c) => c.passed)).toBe(true);
        expect(feature.B.some((c) => !c.passed)).toBe(true);
        await applyReference(s, 'B');
        const all = await functionalChecks(s);
        expect(all.A.concat(all.B).filter((c) => !c.passed)).toEqual([]);
        expect(all.A.find((c) => c.id === 'null_status')?.passed).toBe(true);
        expect(all.B.find((c) => c.id === 'completed_retry_no_finalize')?.passed).toBe(
          true,
        );
        expect(
          (await functionalChecks(s, true)).A.find((c) => c.id === 'current_default')
            ?.passed,
        ).toBe(false);
        await applyReference(s, 'A', true);
        expect((await functionalChecks(s, true)).A.every((c) => c.passed)).toBe(true);
        await putFiles(s, {
          'src/recovery/key.mjs': "export const keyFor=(m,r)=>m+':'+r;\n",
        });
        expect(
          (await functionalChecks(s, true)).B.find((c) => c.id === 'identity_isolation')
            ?.passed,
        ).toBe(false);
      } finally {
        await s.dispose();
      }
    });
});
