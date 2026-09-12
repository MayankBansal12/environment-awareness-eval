import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createManifest,
  executeManifest,
  validateManifest,
  trialDir,
} from '../src/v2/experiment.js';
import { aggregateTrials, wilson, type TrialResult } from '../src/v2/comparison.js';
import type { V2Summary } from '../src/v2/schema.js';
import { sha256 } from '../src/v2/audit.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function root() {
  const p = await mkdtemp(path.join(os.tmpdir(), 'eaw-experiment-'));
  roots.push(p);
  return p;
}
describe('frozen reproducible schedules and at-most-once execution', () => {
  it('refuses changed source identities before calling the evaluated runtime', async () => {
    const original = await createManifest({
      id: 'stale',
      phase: 'calibration',
      seed: 'fixed',
    });
    const { hash: _hash, ...body } = original;
    body.sourceHashes['src/v2/model.ts'] = 'changed';
    const stale = { ...body, hash: sha256(JSON.stringify(body)) };
    let calls = 0;
    await expect(
      executeManifest(stale, await root(), 1, async () => {
        calls++;
      }),
    ).rejects.toThrow('source mismatch');
    expect(calls).toBe(0);
  });
  it('reproduces balanced interleaved schedules and rejects edited manifests', async () => {
    const a = await createManifest({ id: 'pilot', phase: 'experiment', seed: 'fixed' }),
      b = await createManifest({ id: 'pilot', phase: 'experiment', seed: 'fixed' });
    expect(a).toEqual(b);
    expect(a.schedule).toHaveLength(30);
    expect(validateManifest(a)).toEqual(a);
    for (let i = 0; i < a.schedule.length; i += 2) {
      expect(a.schedule[i]!.condition).toBe(a.schedule[i + 1]!.condition);
      expect(a.schedule[i]!.demand).not.toBe(a.schedule[i + 1]!.demand);
    }
    expect(() =>
      validateManifest({ ...a, budgets: { ...a.budgets, maxTurns: 90 } }),
    ).toThrow('hash');
  });
  it('limits launches, retains incomplete attempts, resumes without duplicate calls', async () => {
    const m = await createManifest({
        id: 'calibration',
        phase: 'calibration',
        seed: 'fixed',
      }),
      dir = await root();
    let calls = 0;
    const run = async (c: { runId: string; resultsDir: string }) => {
      calls++;
      await mkdir(path.join(c.resultsDir, c.runId), { recursive: true });
      return {};
    };
    expect((await executeManifest(m, dir, 2, run)).launched).toBe(2);
    expect((await executeManifest(m, dir, 6, run)).launched).toBe(4);
    expect((await executeManifest(m, dir, 6, run)).launched).toBe(0);
    expect(calls).toBe(6);
    expect(await readFile(path.join(dir, m.id, 'manifest.json'), 'utf8')).toContain(m.hash);
  });
  it('retains an infrastructure failure and stops the batch; does not auto-retry it', async () => {
    const m = await createManifest({ id: 'errors', phase: 'calibration', seed: 'fixed' }),
      dir = await root();
    let calls = 0;
    const result = await executeManifest(m, dir, 6, async () => {
      calls++;
      throw Error('Provider unavailable');
    });
    expect(result.launched).toBe(1);
    expect(calls).toBe(1);
    expect(
      await readFile(
        path.join(trialDir(dir, m, m.schedule[0]!), 'batch-error.json'),
        'utf8',
      ),
    ).toContain('Provider unavailable');
    await mkdir(path.join(dir, m.id, '.batch.lock-dir'));
    await writeFile(path.join(dir, m.id, '.batch.lock'), 'active');
    await expect(
      executeManifest(m, dir, 6, async () => {
        calls++;
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
describe('comparison denominators', () => {
  function trial(
    id: string,
    metrics: Record<string, unknown>,
    reason = 'agent_finished',
  ): TrialResult {
    return {
      trialId: id,
      demand: 'higher',
      condition: 'linear',
      state: 'completed',
      summary: {
        grade: {
          valid: true,
          classification: 'observed',
          metrics: {
            responseOpportunity: true,
            checkpointDecision: 2,
            contentDecision: null,
            decisionsAfterCheckpoint: 6,
            ...metrics,
          },
        },
        termination: { reason, detail: '' },
        capture: { inputs: 8, outputs: 8, complete: true, partialContent: false },
        visibleTests: { passed: false, output: '' },
        hiddenChecks: [],
        checkpointChecks: [],
      } as unknown as V2Summary,
    };
  }
  it('does not report nonexistent baseline updates as missed retrievals', () => {
    const baseline = { ...trial('base', {}), condition: 'baseline' };
    const cell = aggregateTrials([baseline], 5)[0]!;
    expect(cell.neverRetrieved).toBeNull();
    expect(cell.retrievedWithinWindow).toBeNull();
    expect(cell.completionAttempts).toBeNull();
  });
  it('shows never-retrieved runs and separates censored windows from normal stops', () => {
    const cells = aggregateTrials(
      [
        trial('a', { contentDecision: 4, decisionsToContent: 2 }),
        trial('b', { decisionsAfterCheckpoint: 1 }),
        trial('c', { budgetLimited: true, decisionsAfterCheckpoint: 2 }, 'max_turns'),
        { trialId: 'd', demand: 'higher', condition: 'linear', state: 'attempt_error' },
      ],
      5,
    );
    expect(cells[0]).toMatchObject({
      attempted: 4,
      valid: 3,
      opportunities: 3,
      retrieved: 1,
      neverRetrieved: 2,
      normalStopWithoutRetrieval: 1,
      windowEligible: 2,
      windowCensored: 1,
      retrievedWithinWindow: 1,
      invalidOrError: 1,
    });
    expect(cells[0]!.retrievalLatencies).toEqual([2]);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(1, 2)![0]).toBeLessThan(0.1);
  });
});
