import { mkdir, readFile, writeFile, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { sha256 } from '../v2/audit.js';
import { sourceIdentity, PROJECT_ROOT } from '../v2/identity.js';
import { demandSchema } from '../v2/state.js';
import { deliverySchema, sequenceSchema } from './state.js';
import { FIXTURE_VERSION, fixtureFiles } from './fixture.js';
import { run, SYSTEM_PROMPT } from './runner.js';
import type { Summary, DerivedAnalysis } from './schema.js';
import { aggregate } from './comparison.js';
import { DEFAULT_SELECTION, modelSelectionSchema, type ModelSelection } from './model.js';

export const profileSchema = z.enum([
  'switching-pilot',
  'matched-revision',
  'demand-baseline',
  'model-comparison',
]);
export type Profile = z.infer<typeof profileSchema>;
const trialSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  sequence: sequenceSchema,
  delivery: deliverySchema,
  demand: demandSchema,
  replicate: z.number().int().min(1).max(3).optional(),
});
/** Balanced blocks: demand order alternates; the seed chooses sequence and first demand. */
export function schedule(profile: Profile, seed: number): z.infer<typeof trialSchema>[] {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw Error('Invalid schedule seed');
  const trials: z.infer<typeof trialSchema>[] = [];
  const add = (
    sequence: z.infer<typeof sequenceSchema>,
    demand: 'lower' | 'higher',
    replicate: number,
  ) =>
    trials.push({
      id: 't' + String(trials.length + 1).padStart(3, '0'),
      sequence,
      delivery: 'linear',
      demand,
      replicate,
    });
  if (profile === 'switching-pilot') {
    for (const sequence of ['sequential', 'interrupted', 'changed'] as const)
      add(sequence, 'higher', 1);
  } else {
    const sequences =
      profile === 'model-comparison'
        ? (['sequential', 'interrupted', 'changed'] as const)
        : profile === 'demand-baseline'
          ? (['sequential', 'sequential', 'sequential'] as const)
          : seed & 2
            ? (['changed', 'interrupted'] as const)
            : (['interrupted', 'changed'] as const);
    sequences.forEach((sequence, i) => {
      const order =
        (seed + i) % 2 ? (['higher', 'lower'] as const) : (['lower', 'higher'] as const);
      for (const demand of order)
        add(sequence, demand, profile === 'demand-baseline' ? i + 1 : 1);
    });
  }
  return trials;
}

export const manifestSchema = z
  .object({
    version: z.literal('3.0'),
    phase: z.literal('development-calibration'),
    id: z.string().regex(/^[A-Za-z0-9._-]+$/),
    createdAt: z.string(),
    fixtureVersion: z.string(),
    sources: z.record(z.string(), z.string()),
    fixtureHashes: z.record(z.string(), z.string()),
    systemPromptHash: z.string(),
    model: z.enum([
      'opencode/muse-spark-1.3-contributor-free',
      'openai-codex/gpt-6-astra',
      'openai-codex/gpt-5.6-sol',
    ]),
    modelConfig: modelSelectionSchema.optional(),
    design: z
      .object({
        profile: profileSchema,
        scheduleSeed: z.number().int().min(0).max(0xffffffff),
        repetitionsPerCell: z.number().int().min(1).max(3),
        demandLocation: z.literal('urgent-debugging-task-only'),
        hypothesis: z.string(),
        caveat: z.string(),
      })
      .optional(),
    budgets: z.object({
      maxTurns: z.number().int().min(1).max(100),
      maxActions: z.number().int().min(1).max(300),
      timeoutMs: z.number().int().min(1000).max(1200000),
    }),
    trials: z.array(trialSchema).min(1).max(6),
  })
  .superRefine((m, ctx) => {
    const selection = m.modelConfig ?? DEFAULT_SELECTION;
    if (m.model !== `${selection.provider}/${selection.model}`)
      ctx.addIssue({
        code: 'custom',
        message: 'Model identity does not match explicit configuration',
      });
    if (new Set(m.trials.map((t) => t.id)).size !== m.trials.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate trial IDs' });
    if (
      m.design &&
      JSON.stringify(m.trials) !==
        JSON.stringify(schedule(m.design.profile, m.design.scheduleSeed))
    )
      ctx.addIssue({ code: 'custom', message: 'Schedule does not match frozen design' });
  });
export async function freeze(
  file: string,
  id: string,
  profile: Profile = 'switching-pilot',
  seed = 0,
  modelConfig: ModelSelection = DEFAULT_SELECTION,
) {
  const sources = await sourceIdentity();
  const manifest = manifestSchema.parse({
    version: '3.0',
    phase: 'development-calibration',
    id,
    createdAt: new Date().toISOString(),
    fixtureVersion: FIXTURE_VERSION,
    sources,
    fixtureHashes: Object.fromEntries(
      ['lower', 'higher'].map((d) => [
        d,
        sha256(JSON.stringify(fixtureFiles(d as 'lower' | 'higher'))),
      ]),
    ),
    systemPromptHash: sha256(SYSTEM_PROMPT),
    model: `${modelConfig.provider}/${modelConfig.model}`,
    modelConfig,
    design: {
      profile,
      scheduleSeed: seed,
      repetitionsPerCell: profile === 'demand-baseline' ? 3 : 1,
      demandLocation: 'urgent-debugging-task-only',
      hypothesis:
        profile === 'model-comparison'
          ? 'How does the selected model retrieve urgent assignments, preserve unfinished work, resume, and adapt across matched demand variants?'
          : profile === 'matched-revision'
            ? 'Does more urgent debugging work change retrieval/adaptation to revised feature requirements and unaided return to the paused feature?'
            : 'Does the higher variant create more sustained urgent debugging work while remaining solvable?',
      caveat:
        'Feature A is identical across demand variants. Initial assignment discovery does not test focal-demand blindness. Development samples cannot establish an effect or pin provider weights.',
    },
    budgets: { maxTurns: 80, maxActions: 200, timeoutMs: 900000 },
    trials: schedule(profile, seed),
  });
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const snapshot = Object.fromEntries(
    await Promise.all(
      Object.keys(sources).map(async (n) => [
        n,
        await readFile(path.join(PROJECT_ROOT, n), 'utf8'),
      ]),
    ),
  );
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await writeFile(
    file + '.sources.json.gz',
    gzipSync(JSON.stringify({ sources, files: snapshot })),
    { flag: 'wx' },
  );
  return manifest;
}
export async function execute(file: string, root: string, maxNew: number) {
  if (!Number.isInteger(maxNew) || maxNew < 1 || maxNew > 3)
    throw Error('Choose 1–3 new runs');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (manifest.fixtureVersion !== FIXTURE_VERSION)
    throw Error('Frozen fixture version mismatch');
  if (
    JSON.stringify(await sourceIdentity()) !== JSON.stringify(manifest.sources) ||
    manifest.systemPromptHash !== sha256(SYSTEM_PROMPT)
  )
    throw Error('Frozen source/prompt mismatch');
  for (const d of ['lower', 'higher'] as const)
    if (manifest.fixtureHashes[d] !== sha256(JSON.stringify(fixtureFiles(d))))
      throw Error('Frozen fixture mismatch');
  const dir = path.resolve(root, manifest.id);
  await mkdir(dir, { recursive: true });
  const lock = await open(path.join(dir, '.batch.lock'), 'wx');
  let count = 0;
  try {
    const recorded = path.join(dir, 'manifest.json');
    try {
      const prior = await readFile(recorded, 'utf8');
      if (JSON.stringify(JSON.parse(prior)) !== JSON.stringify(manifest))
        throw Error('Result directory belongs to a different manifest');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(recorded, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    }
    // Validate all existing result/trial links before permitting any new inference.
    const existing = await compare(file, root);
    if (existing.haltedBy) return existing;
    for (const trial of manifest.trials) {
      if (count >= maxNew) break;
      try {
        const previous = JSON.parse(
          await readFile(path.join(dir, 'runs', trial.id, 'summary.json'), 'utf8'),
        ) as Summary;
        if (
          !previous.grade.valid ||
          previous.termination.reason !== 'agent_finished' ||
          (trial.sequence === 'sequential' &&
            !previous.evidence.final.A.concat(previous.evidence.final.B).every(
              (c) => c.passed,
            ))
        )
          break;
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      // Existing failed/incomplete attempts are never overwritten or retried automatically.
      try {
        await stat(path.join(dir, 'runs', trial.id));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      count++;
      const summary = await run({
        runId: trial.id,
        resultsDir: path.join(dir, 'runs'),
        ...trial,
        ...manifest.budgets,
        keepWorkspace: true,
        expectedSources: manifest.sources,
        manifestHash: sha256(JSON.stringify(manifest)),
        modelConfig: manifest.modelConfig ?? DEFAULT_SELECTION,
      });
      await compare(file, root);
      if (!summary.grade.valid || summary.termination.reason !== 'agent_finished') break;
      if (
        trial.sequence === 'sequential' &&
        !summary.evidence.final.A.concat(summary.evidence.final.B).every((c) => c.passed)
      )
        break;
    }
  } finally {
    await lock.close();
    await unlink(path.join(dir, '.batch.lock'));
  }
  return compare(file, root);
}
export async function compare(file: string, root: string) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8'))),
    dir = path.resolve(root, manifest.id);
  const selection = manifest.modelConfig ?? DEFAULT_SELECTION;
  const trialIdentity = { model: manifest.model, thinking: selection.thinking };
  const trials = [];
  for (const trial of manifest.trials) {
    const p = path.join(dir, 'runs', trial.id);
    try {
      const raw = await readFile(path.join(p, 'summary.json'), 'utf8'),
        s = JSON.parse(raw) as Summary;
      if (
        s.runtime?.['manifestHash'] !== sha256(JSON.stringify(manifest)) ||
        s.runId !== trial.id ||
        s.sequence !== trial.sequence ||
        s.demand !== trial.demand ||
        s.delivery !== trial.delivery
      )
        throw Error('Run does not match its manifest trial');
      if (
        s.runtime['provider'] !== selection.provider ||
        s.runtime['model'] !== selection.model ||
        s.runtime['thinking'] !== selection.thinking
      )
        throw Error('Run model/reasoning does not match its manifest');
      const receipt = JSON.parse(
        await readFile(path.join(p, 'result-receipt.json'), 'utf8'),
      ) as Record<string, string>;
      for (const name of ['summary.json', 'audit.json', 'integrity.json']) {
        if (
          receipt[name] !==
          sha256(name === 'summary.json' ? raw : await readFile(path.join(p, name)))
        )
          throw Error('Run receipt mismatch: ' + name);
      }
      let analysis: DerivedAnalysis | undefined, analysisHash: string | undefined;
      for (const name of ['analysis-v311.json', 'analysis-v301.json']) {
        try {
          const text = await readFile(path.join(p, name), 'utf8');
          analysis = JSON.parse(text) as DerivedAnalysis;
          if (analysis.originalSummarySha256 !== sha256(raw))
            throw Error('Derived analysis refers to a different summary');
          analysisHash = sha256(text);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      const grade = analysis?.grade ?? s.grade;
      trials.push({
        ...trial,
        ...trialIdentity,
        state: 'completed',
        summaryHash: sha256(raw),
        outcome: grade.outcome,
        originalOutcome: s.grade.outcome,
        analysisVersion: analysis?.analysisVersion ?? 'original',
        ...(analysisHash ? { analysisHash } : {}),
        valid: grade.valid,
        termination: s.termination,
        metrics: grade.metrics,
        gates: grade.gates,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      let state = 'not_started';
      try {
        await readFile(path.join(p, 'attempt-error.json'));
        state = 'setup_or_controller_failure';
      } catch {
        const { stat } = await import('node:fs/promises');
        try {
          await stat(p);
          state = 'incomplete_attempt';
        } catch {
          /* no run */
        }
      }
      trials.push({ ...trial, ...trialIdentity, state });
    }
  }
  const report = {
    format: 'environment-v3-comparison',
    manifestHash: sha256(JSON.stringify(manifest)),
    phase: manifest.phase,
    modelConfig: selection,
    design: manifest.design ?? null,
    note: 'Bounded development calibration. No heavy-load or blindness-effect claim. Initial feature work is identical across demand variants; demand changes urgent debugging only. No automatic retries or progression past failed attempts. Original grades and versioned analyses remain distinct.',
    trials,
    haltedBy:
      trials.find(
        (t) =>
          t.state !== 'not_started' &&
          (t.state !== 'completed' ||
            ('valid' in t &&
              (!t.valid ||
                t.termination.reason !== 'agent_finished' ||
                (t.sequence === 'sequential' &&
                  t.gates.some(
                    (g) =>
                      ['feature_final_correct', 'urgent_fix_preserved'].includes(g.id) &&
                      !g.passed,
                  ))))),
      )?.id ?? null,
    statistics: aggregate(trials),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'comparison.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile(
    path.join(dir, 'comparison.md'),
    `# Switching development calibration\n\nModel: ${manifest.model}; reasoning: ${selection.thinking}.\n\n${report.note}\n\n|Trial|Sequence|Demand|State|Outcome|Decisions|Discovery delay|Resumption delay|\n|---|---|---|---|---|---:|---:|---:|\n` +
      trials
        .map(
          (t) =>
            `|${t.id}|${t.sequence}|${t.demand}|${t.state}|${'outcome' in t ? t.outcome : '—'}|${'metrics' in t ? t.metrics['decisions'] : '—'}|${'metrics' in t ? t.metrics['discoveryDelay'] : '—'}|${'metrics' in t ? t.metrics['resumptionDelay'] : '—'}|`,
        )
        .join('\n') +
      '\n\n' +
      report.statistics.interpretation +
      '\n\nSee comparison.json for denominators, opportunity counts, raw distributions and matched contrasts.\n',
  );
  return report;
}
