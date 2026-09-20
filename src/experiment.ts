import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { sha256 } from './harness/identity.js';
import { PROJECT_ROOT, sourceIdentity } from './harness/identity.js';
import {
  DEFAULT_SELECTION,
  modelSelectionSchema,
  type ModelSelection,
} from './harness/model.js';
import { fixtureDigest } from './fixture.js';
import {
  DEFAULT_BUDGETS,
  PROTOCOL_VERSION,
  run,
  SYSTEM_PROMPT,
  type Budgets,
} from './runner.js';
import {
  conditionSchema,
  FAMILIES,
  familySchema,
  importantKinds,
  loadSchema,
  prng,
  SCRIPT_VERSION,
  type FamilyId,
} from './scenario.js';
import type { Summary } from './schema.js';

export const profileSchema = z.enum(['smoke', 'load-sweep', 'controls']);
export type Profile = z.infer<typeof profileSchema>;
const trialSchema = conditionSchema.extend({
  id: z.string().regex(/^t\d{3}$/),
  replicate: z.number().int().min(1).max(10),
});
type Trial = z.infer<typeof trialSchema>;
const budgetsSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(4 * 3_600_000),
  maxTotalTokens: z.number().int().min(100_000).max(200_000_000),
  providerRetries: z.number().int().min(0).max(10),
  compaction: z.boolean(),
});

export const manifestSchema = z.object({
  version: z.literal('4.0'),
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  createdAt: z.string(),
  protocolVersion: z.string(),
  scriptVersion: z.string(),
  familyVersions: z.record(z.string(), z.string()),
  fixtureHashes: z.record(z.string(), z.string()),
  sources: z.record(z.string(), z.string()),
  systemPromptHash: z.string(),
  modelConfig: modelSelectionSchema,
  budgets: budgetsSchema,
  /** A provider_error attempt is retained and the trial re-attempted up to this many times. */
  maxAttemptsPerTrial: z.number().int().min(1).max(5),
  design: z.object({
    profile: profileSchema,
    seed: z.number().int().min(0).max(0xffffffff),
    repetitions: z.number().int().min(1).max(10),
    families: z.array(familySchema).min(1),
  }),
  trials: z.array(trialSchema).min(1).max(500),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Wilson interval: describes an observed proportion, not a causal effect. */
export function fraction(successes: number, n: number) {
  if (!n) return { successes, n, proportion: null, interval95: null };
  const z = 1.959963984540054,
    p = successes / n,
    d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return {
    successes,
    n,
    proportion: p,
    interval95: [Math.max(0, c - h), Math.min(1, c + h)],
  };
}

const hashCombine = (...parts: Array<string | number>) =>
  parseInt(sha256(parts.join('|')).slice(0, 8), 16);

/**
 * Replicate blocks with a seeded order inside each block. The noise seed depends on
 * (seed, family, replicate) only, so loads within a replicate see the same noise stream.
 */
export function schedule(
  profile: Profile,
  seed: number,
  repetitions: number,
  families: FamilyId[],
): Trial[] {
  type Cell = Omit<Trial, 'id' | 'replicate' | 'seed'>;
  let cells: Cell[];
  if (profile === 'smoke')
    cells = [
      { family: families[0]!, load: 'medium', noise: 'normal', delivery: 'ambient' },
    ];
  else if (profile === 'load-sweep')
    cells = families.flatMap((family) =>
      loadSchema.options.map((load) => ({
        family,
        load,
        noise: 'normal' as const,
        delivery: 'ambient' as const,
      })),
    );
  else
    cells = families.flatMap((family) => [
      {
        family,
        load: 'high' as const,
        noise: 'none' as const,
        delivery: 'ambient' as const,
      },
      {
        family,
        load: 'high' as const,
        noise: 'normal' as const,
        delivery: 'exposed' as const,
      },
    ]);
  const reps = profile === 'smoke' ? 1 : repetitions;
  const trials: Trial[] = [];
  for (let replicate = 1; replicate <= reps; replicate++) {
    const random = prng(hashCombine(seed, profile, replicate));
    const block = [...cells];
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [block[i], block[j]] = [block[j]!, block[i]!];
    }
    for (const cell of block)
      trials.push({
        ...cell,
        id: 't' + String(trials.length + 1).padStart(3, '0'),
        replicate,
        seed: hashCombine(seed, cell.family, replicate),
      });
  }
  return trials;
}

function fixtureHashes() {
  return Object.fromEntries(
    familySchema.options.flatMap((f) =>
      loadSchema.options.map((l) => [`${f}/${l}`, fixtureDigest(FAMILIES[f], l)]),
    ),
  );
}

export async function freeze(
  file: string,
  options: {
    id: string;
    profile: Profile;
    seed?: number;
    repetitions?: number;
    families?: FamilyId[];
    modelConfig?: ModelSelection;
    budgets?: Partial<Budgets>;
    maxAttemptsPerTrial?: number;
  },
) {
  const sources = await sourceIdentity();
  const families = options.families ?? [...familySchema.options];
  const seed = options.seed ?? 0,
    repetitions = options.repetitions ?? 3;
  const manifest = manifestSchema.parse({
    version: '4.0',
    id: options.id,
    createdAt: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    scriptVersion: SCRIPT_VERSION,
    familyVersions: Object.fromEntries(
      familySchema.options.map((f) => [f, FAMILIES[f].version]),
    ),
    fixtureHashes: fixtureHashes(),
    sources,
    systemPromptHash: sha256(SYSTEM_PROMPT),
    modelConfig: options.modelConfig ?? DEFAULT_SELECTION,
    budgets: { ...DEFAULT_BUDGETS, ...options.budgets },
    maxAttemptsPerTrial: options.maxAttemptsPerTrial ?? 2,
    design: { profile: options.profile, seed, repetitions, families },
    trials: schedule(options.profile, seed, repetitions, families),
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
    {
      flag: 'wx',
    },
  );
  return manifest;
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

type AttemptState =
  | { id: string; state: 'completed'; summary: Summary }
  | { id: string; state: 'provider_error'; summary: Summary | null }
  | { id: string; state: 'harness_error' | 'incomplete' };

async function attempts(runsDir: string, trial: Trial): Promise<AttemptState[]> {
  const out: AttemptState[] = [];
  for (let n = 1; ; n++) {
    const id = n === 1 ? trial.id : `${trial.id}.r${n}`;
    const dir = path.join(runsDir, id);
    if (!(await exists(dir))) break;
    if (await exists(path.join(dir, 'summary.json'))) {
      const summary = JSON.parse(
        await readFile(path.join(dir, 'summary.json'), 'utf8'),
      ) as Summary;
      out.push(
        summary.termination.reason === 'provider_error'
          ? { id, state: 'provider_error', summary }
          : { id, state: 'completed', summary },
      );
    } else {
      const error = (await exists(path.join(dir, 'attempt-error.json')))
        ? (JSON.parse(await readFile(path.join(dir, 'attempt-error.json'), 'utf8')) as {
            error: string;
          })
        : null;
      out.push(
        error && /provider|timeout|ECONN|socket|429|5\d\d/i.test(error.error)
          ? { id, state: 'provider_error', summary: null }
          : { id, state: error ? 'harness_error' : 'incomplete' },
      );
    }
  }
  return out;
}

async function verifyFrozen(manifest: Manifest) {
  if (JSON.stringify(await sourceIdentity()) !== JSON.stringify(manifest.sources))
    throw Error('Frozen source mismatch: freeze a new manifest after code changes');
  if (manifest.systemPromptHash !== sha256(SYSTEM_PROMPT))
    throw Error('Frozen prompt mismatch');
  if (JSON.stringify(fixtureHashes()) !== JSON.stringify(manifest.fixtureHashes))
    throw Error('Frozen fixture mismatch');
}

/**
 * Runs pending trials in schedule order. Behavioral failures never stop the batch. Provider
 * errors are retained and re-attempted; a harness error or incomplete attempt stops the batch.
 */
export async function execute(file: string, root: string, maxNew = Infinity) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  await verifyFrozen(manifest);
  const dir = path.resolve(root, manifest.id),
    runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const lock = await open(path.join(dir, '.batch.lock'), 'wx');
  let launched = 0;
  let haltedBy: string | null = null;
  try {
    const recorded = path.join(dir, 'manifest.json');
    if (await exists(recorded)) {
      if (
        JSON.stringify(JSON.parse(await readFile(recorded, 'utf8'))) !==
        JSON.stringify(manifest)
      )
        throw Error('Result directory belongs to a different manifest');
    } else
      await writeFile(recorded, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    for (const trial of manifest.trials) {
      if (launched >= maxNew) break;
      const prior = await attempts(runsDir, trial);
      const last = prior.at(-1);
      if (last?.state === 'completed') continue;
      if (last?.state === 'harness_error' || last?.state === 'incomplete') {
        haltedBy = `${last.id}: ${last.state}`;
        break;
      }
      if (prior.length >= manifest.maxAttemptsPerTrial) continue;
      const runId = prior.length ? `${trial.id}.r${prior.length + 1}` : trial.id;
      launched++;
      console.log(
        `\n=== ${runId} ${trial.family}/${trial.load}/${trial.noise}/${trial.delivery} rep ${trial.replicate}`,
      );
      try {
        await run({
          runId,
          resultsDir: runsDir,
          condition: {
            family: trial.family,
            load: trial.load,
            noise: trial.noise,
            delivery: trial.delivery,
            seed: trial.seed,
          },
          budgets: manifest.budgets,
          keepWorkspace: false,
          expectedSources: manifest.sources,
          manifestHash: sha256(JSON.stringify(manifest)),
          modelConfig: manifest.modelConfig,
        });
      } catch (e) {
        console.error(`${runId} attempt error: ${String(e)}`);
      }
      await compare(file, root);
    }
  } finally {
    await lock.close();
    await unlink(path.join(dir, '.batch.lock'));
  }
  return { launched, haltedBy, ...(await compare(file, root)) };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b),
    m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const avg = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const nums = (xs: Array<number | null | undefined>) =>
  xs.filter((x): x is number => typeof x === 'number');

interface TrialRecord {
  trial: Trial;
  attempts: Array<{ id: string; state: AttemptState['state'] }>;
  summary: Summary | null;
}

export async function compare(file: string, root: string) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const dir = path.resolve(root, manifest.id),
    runsDir = path.join(dir, 'runs');
  const trials: TrialRecord[] = [];
  for (const trial of manifest.trials) {
    const all = (await exists(runsDir)) ? await attempts(runsDir, trial) : [];
    const final = [...all].reverse().find((a) => a.state === 'completed');
    trials.push({
      trial,
      attempts: all.map((a) => ({ id: a.id, state: a.state })),
      summary: final?.state === 'completed' ? final.summary : null,
    });
  }
  const result = summarize(manifest, trials);
  if (await exists(dir)) {
    await writeFile(
      path.join(dir, 'comparison.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    await writeFile(path.join(dir, 'comparison.md'), renderComparison(result));
  }
  return result;
}
export type Comparison = ReturnType<typeof summarize>;

export function summarize(manifest: Manifest, trials: TrialRecord[]) {
  const key = (t: Trial) => `${t.family}/${t.load}/${t.noise}/${t.delivery}`;
  const cells = [...new Set(manifest.trials.map(key))].map((cellKey) => {
    const members = trials.filter((t) => key(t.trial) === cellKey);
    const done = members.flatMap((t) => (t.summary ? [t.summary] : []));
    const valid = done.filter((s) => s.grade.valid);
    const uncensored = valid.filter((s) => !s.grade.censored);
    const events = Object.fromEntries(
      importantKinds.map((kind) => {
        const metrics = valid
          .map((s) => s.grade.events.find((e) => e.kind === kind)!)
          .filter((e) => e?.fired);
        const assessableRetrieval = metrics.filter((e) => e.missed !== null);
        const completedOutcomes = uncensored.flatMap((s) =>
          s.grade.events.filter((e) => e.kind === kind && e.fired),
        );
        return [
          kind,
          {
            fired: metrics.length,
            missed: fraction(
              assessableRetrieval.filter((e) => e.missed).length,
              assessableRetrieval.length,
            ),
            retrievalUnassessable: metrics.length - assessableRetrieval.length,
            detectionLatencyMedian: median(nums(metrics.map((e) => e.detectionLatency))),
            detectionLatencyMean: avg(nums(metrics.map((e) => e.detectionLatency))),
            focalChangesBeforeContentMean: avg(
              nums(metrics.map((e) => e.focalChangesBeforeContent)),
            ),
            commitsBeforeContentMean: avg(nums(metrics.map((e) => e.commitsBeforeContent))),
            adapted: fraction(
              completedOutcomes.filter((e) => e.adapted).length,
              completedOutcomes.length,
            ),
            contextTokensAtFireMean: avg(nums(metrics.map((e) => e.contextTokensAtFire))),
            focalChecksFailingAtFireMean: avg(
              nums(metrics.map((e) => e.focalChecksFailingAtFire)),
            ),
            firedDuringTestFailure: metrics.filter((e) => e.firedDuringTestFailure).length,
          },
        ];
      }),
    );
    return {
      cell: cellKey,
      scheduled: members.length,
      completed: done.length,
      valid: valid.length,
      censored: valid.length - uncensored.length,
      attempts: members.reduce((n, t) => n + t.attempts.length, 0),
      events,
      outcome: {
        focalBaseChecksPassedMean: avg(
          valid.map((s) => Number(s.grade.outcome['focalBaseChecksPassed'])),
        ),
        focalBaseChecksTotal: valid[0]?.grade.outcome['focalBaseChecksTotal'] ?? null,
        focalAllChecks: fraction(
          valid.filter((s) => s.grade.outcome['focalAllChecksPassed']).length,
          valid.length,
        ),
        hotfixCorrect: fraction(
          valid.filter((s) => s.grade.urgent['hotfixCorrect'] === true).length,
          valid.length,
        ),
        visibleTestsPass: fraction(
          valid.filter((s) => s.grade.outcome['visibleTestsPass']).length,
          valid.length,
        ),
      },
      usage: {
        totalTokensMean: avg(done.map((s) => s.usage.totalTokens)),
        outputTokensMean: avg(done.map((s) => s.usage.output)),
        costUsdMean: avg(done.map((s) => s.usage.costUsd.total)),
        costUsdTotal: done.reduce((n, s) => n + s.usage.costUsd.total, 0),
        durationMinutesMean: avg(done.map((s) => s.durationMs / 60000)),
        decisionsMean: avg(done.map((s) => s.usage.turnCalls)),
      },
    };
  });
  const result = {
    manifest: manifest.id,
    model: `${manifest.modelConfig.provider}/${manifest.modelConfig.model}/${manifest.modelConfig.thinking}`,
    scheduled: manifest.trials.length,
    completed: trials.filter((t) => t.summary).length,
    trials: trials.map((t) => ({
      id: t.trial.id,
      cell: key(t.trial),
      replicate: t.trial.replicate,
      attempts: t.attempts,
      termination: t.summary?.termination.reason ?? null,
      valid: t.summary?.grade.valid ?? null,
      costUsd: t.summary?.usage.costUsd.total ?? null,
      totalTokens: t.summary?.usage.totalTokens ?? null,
    })),
    cells,
    note: 'Descriptive only. Wilson intervals describe observed proportions, not causal effects.',
  };
  return result;
}

function renderComparison(r: Comparison): string {
  const pct = (f: { proportion: number | null; n: number }) =>
    f.proportion === null ? '—' : `${Math.round(f.proportion * 100)}% (n=${f.n})`;
  const n = (v: number | null | undefined, d = 1) =>
    v === null || v === undefined ? '—' : v.toFixed(d);
  const lines = [
    `# ${r.manifest}`,
    '',
    `Model ${r.model}. ${r.completed}/${r.scheduled} trials completed.`,
    '',
    '| Cell | Valid | Update | Content not retrieved | Retrieval latency median | Focal edits before content | Correct final behavior | Failing checks at fire |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const c of r.cells)
    for (const [kind, e] of Object.entries(c.events))
      lines.push(
        `| ${c.cell} | ${c.valid}/${c.scheduled} | ${kind} | ${pct(e.missed)} | ${n(e.detectionLatencyMedian)} | ${n(e.focalChangesBeforeContentMean)} | ${pct(e.adapted)} | ${n(e.focalChecksFailingAtFireMean)} |`,
      );
  lines.push(
    '',
    '| Cell | Focal base checks | Hotfix correct | Tokens (mean) | Cost mean / total (USD) | Minutes (mean) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const c of r.cells)
    lines.push(
      `| ${c.cell} | ${n(c.outcome.focalBaseChecksPassedMean)}/${c.outcome.focalBaseChecksTotal ?? '—'} | ${pct(c.outcome.hotfixCorrect)} | ${n(c.usage.totalTokensMean, 0)} | ${n(c.usage.costUsdMean, 2)} / ${n(c.usage.costUsdTotal, 2)} | ${n(c.usage.durationMinutesMean)} |`,
    );
  lines.push('', r.note, '');
  return lines.join('\n');
}
