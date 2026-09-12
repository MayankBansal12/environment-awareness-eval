import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
vi.mock('../src/v3/runner.js', () => ({ SYSTEM_PROMPT: 'test prompt', run: vi.fn() }));
import { run } from '../src/v3/runner.js';
import {
  freeze,
  execute,
  schedule,
  manifestSchema,
  compare,
} from '../src/v3/experiment.js';
import { aggregate, fraction } from '../src/v3/comparison.js';
import type { Summary } from '../src/v3/schema.js';
import { sha256 } from '../src/v2/audit.js';
afterEach(() => vi.mocked(run).mockReset());
describe('bounded switching experiments', () => {
  it('freezes exact source bytes and refuses changes before inference', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-freeze-'));
    try {
      const file = path.join(dir, 'manifest.json'),
        m = await freeze(file, 'pilot');
      const snapshot = JSON.parse(
        gunzipSync(await readFile(file + '.sources.json.gz')).toString(),
      ) as { files: Record<string, string> };
      expect(m.trials).toHaveLength(3);
      for (const [name, hash] of Object.entries(m.sources))
        expect(sha256(snapshot.files[name]!)).toBe(hash);
      m.sources['src/v3/state.ts'] = 'changed';
      await writeFile(file, JSON.stringify(m));
      await expect(execute(file, dir, 1)).rejects.toThrow('mismatch');
      expect(run).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('stops after provider failure and cannot bypass that stop by resuming', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-execute-'));
    try {
      const file = path.join(dir, 'manifest.json');
      await freeze(file, 'pilot');
      vi.mocked(run).mockImplementation(async (config) => {
        const s = {
          runId: config.runId,
          sequence: config.sequence,
          demand: config.demand,
          delivery: config.delivery,
          runtime: { manifestHash: config.manifestHash },
          grade: { valid: false, outcome: 'invalid_run', metrics: {}, gates: [] },
          termination: { reason: 'provider_error', detail: 'rate limit' },
          evidence: { final: { A: [], B: [] } },
        } as unknown as Summary;
        await mkdir(path.join(config.resultsDir, config.runId), { recursive: true });
        await writeFile(
          path.join(config.resultsDir, config.runId, 'summary.json'),
          JSON.stringify(s),
        );
        const p = path.join(config.resultsDir, config.runId);
        await writeFile(path.join(p, 'audit.json'), '{}');
        await writeFile(path.join(p, 'integrity.json'), '{}');
        await writeFile(
          path.join(p, 'result-receipt.json'),
          JSON.stringify({
            'summary.json': sha256(JSON.stringify(s)),
            'audit.json': sha256('{}'),
            'integrity.json': sha256('{}'),
          }),
        );
        return s;
      });
      const report = await execute(file, dir, 3);
      expect(run).toHaveBeenCalledTimes(1);
      expect(vi.mocked(run).mock.calls[0]![0].runId).toBe('t001');
      expect(report.trials.map((t) => t.state)).toEqual([
        'completed',
        'not_started',
        'not_started',
      ]);
      await execute(file, dir, 3);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('halts before inference on an existing incomplete attempt', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-incomplete-'));
    try {
      const file = path.join(dir, 'manifest.json');
      await freeze(file, 'pilot');
      await mkdir(path.join(dir, 'pilot', 'runs', 't001'), { recursive: true });
      const report = await execute(file, dir, 3);
      expect(report.trials[0]?.state).toBe('incomplete_attempt');
      expect(run).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('balances matched cells with reproducible order and rejects edited schedules', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-matched-'));
    try {
      const m = await freeze(
        path.join(dir, 'manifest.json'),
        'matched',
        'matched-revision',
        19,
      );
      expect(m.trials).toEqual(schedule('matched-revision', 19));
      expect(m.trials.map((t) => [t.sequence, t.demand])).toEqual([
        ['changed', 'higher'],
        ['changed', 'lower'],
        ['interrupted', 'lower'],
        ['interrupted', 'higher'],
      ]);
      expect(schedule('demand-baseline', 19)).toHaveLength(6);
      m.trials.reverse();
      expect(manifestSchema.safeParse(m).success).toBe(false);
      expect(() => schedule('matched-revision', NaN)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects a result transplanted from a different trial or manifest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-link-'));
    try {
      const file = path.join(dir, 'manifest.json');
      await freeze(file, 'pilot');
      await mkdir(path.join(dir, 'pilot', 'runs', 't001'), { recursive: true });
      await writeFile(
        path.join(dir, 'pilot', 'runs', 't001', 'summary.json'),
        JSON.stringify({ runtime: { manifestHash: 'wrong' } }),
      );
      await expect(compare(file, dir)).rejects.toThrow('manifest trial');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('shows nonretrievers, short-window censoring, and unmatched failures in denominators', () => {
    const base = {
      id: 'a',
      sequence: 'changed' as const,
      demand: 'lower' as const,
      delivery: 'linear' as const,
      replicate: 1,
      state: 'completed',
      valid: true,
      metrics: {
        assignmentDecision: 3,
        revisionDecision: 8,
        firstAssignmentContent: 4,
        revisionResponseOpportunityDuringUrgent: true,
        urgentChecksRemainingAtCheckpoint: 2,
        firstRevisionContent: null,
        revisionWithinFiveDecisions: 'not_retrieved',
      },
    };
    const report = aggregate([
      base,
      {
        ...base,
        id: 'b',
        metrics: {
          ...base.metrics,
          revisionWithinFiveDecisions: 'censored',
          budgetLimited: true,
        },
      },
      {
        id: 'c',
        sequence: 'changed',
        demand: 'higher',
        delivery: 'linear',
        replicate: 1,
        state: 'setup_or_controller_failure',
      },
    ]);
    expect(report.cells[0]?.revisionRetrieved.n).toBe(2);
    expect(report.cells[0]?.revisionNeverRetrieved).toBe(2);
    expect(report.cells[0]?.revisionWithinFiveDecisions.n).toBe(1);
    expect(report.cells[0]?.revisionFiveDecisionCensored).toBe(1);
    expect(report.cells[1]?.incompleteOrSetupFailure).toBe(1);
    expect(report.contrasts[0]?.comparable).toBe(false);
    expect(fraction(1, 1).interval95?.[0]).toBeCloseTo(0.2065, 3);
    expect(fraction(0, 0).proportion).toBeNull();
  });
  it('rejects concurrent execution and oversized requests', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-lock-'));
    try {
      const file = path.join(dir, 'manifest.json');
      await freeze(file, 'pilot');
      await mkdir(path.join(dir, 'pilot'));
      await writeFile(path.join(dir, 'pilot', '.batch.lock'), '');
      await expect(execute(file, dir, 1)).rejects.toThrow();
      await expect(execute(file, dir, 30)).rejects.toThrow('1–3');
      expect(run).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
