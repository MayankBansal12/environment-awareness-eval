import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { freeze, execute, schedule } from '../src/experiment.js';
import { fixtureDigest } from '../src/fixture.js';
import { familyFor } from '../src/scenario.js';
import { SYSTEM_PROMPT, PROTOCOL_VERSION } from '../src/runner.js';
import { sha256 } from '../src/harness/identity.js';
import { FORMAT } from '../src/schema.js';

vi.mock('../src/audit.js', async () => ({
  ...(await vi.importActual('../src/audit.js')),
  auditRun: vi.fn(async () => ({ eligible: true })),
}));

it('schedules five repetitions of all eight cases with seeds matching retained Opus evidence', () => {
  const trials = schedule('scenario-matrix', 1, 5, ['settlement', 'fulfillment']);
  expect(trials).toHaveLength(40);
  for (const family of ['settlement', 'fulfillment'])
    for (const scenario of [
      'updates',
      'task-cancellation',
      'urgency-downgrade',
      'delayed-relevance',
    ]) {
      const members = trials.filter((t) => t.family === family && t.scenario === scenario);
      expect(members.map((t) => t.replicate)).toEqual([1, 2, 3, 4, 5]);
      if (scenario === 'updates')
        expect(members.map((t) => t.seed)).toEqual([1, 2, 3, 4, 5]);
      else expect(members[0]!.seed).toBe(family === 'settlement' ? 1775922842 : 2136586205);
    }
});

it('pins cached behavioral failures without rerunning them and rejects modified saved evidence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eval-reuse-'));
  const saved = path.join(dir, 'saved');
  await mkdir(saved);
  const modelConfig = {
    provider: 'anthropic',
    model: 'claude-opus-5',
    thinking: 'default',
  } as const;
  const condition = {
    family: 'settlement',
    scenario: 'task-cancellation',
    load: 'high',
    noise: 'normal',
    delivery: 'ambient',
    seed: 1775922842,
  } as const;
  const summary = {
    format: FORMAT,
    condition,
    grade: { valid: true, censored: false, summary: { failed: 1 } },
    runtime: {
      ...modelConfig,
      agent: 'claude-code',
      fixtureDigest: fixtureDigest(familyFor(condition), 'high'),
      systemPromptSha256: sha256(SYSTEM_PROMPT),
      protocolVersion: PROTOCOL_VERSION,
      scriptVersion: 'scenario-arms-1.0',
    },
  };
  try {
    await writeFile(path.join(saved, 'summary.json'), JSON.stringify(summary));
    await writeFile(path.join(saved, 'integrity.json'), '{}');
    const file = path.join(dir, 'manifest.json');
    const manifest = await freeze(file, {
      id: 'cached',
      profile: 'scenario-matrix',
      seed: 1,
      repetitions: 5,
      modelConfig,
      reuseDirs: [saved],
    });
    expect(manifest.trials.filter((t) => t.reused)).toHaveLength(1);
    expect(manifest.trials.find((t) => t.reused)?.reused?.compatibility).toContain(
      'downgrade timing only',
    );
    await writeFile(
      path.join(saved, 'summary.json'),
      JSON.stringify({ ...summary, tampered: true }),
    );
    await expect(execute(file, path.join(dir, 'results'), 0)).rejects.toThrow(
      'Saved evidence changed',
    );
    await writeFile(
      path.join(saved, 'summary.json'),
      JSON.stringify({
        ...summary,
        runtime: { ...summary.runtime, scriptVersion: 'obsolete' },
      }),
    );
    await expect(
      freeze(path.join(dir, 'bad.json'), {
        id: 'bad',
        profile: 'scenario-matrix',
        seed: 1,
        modelConfig,
        reuseDirs: [saved],
      }),
    ).rejects.toThrow('incompatible event timing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
