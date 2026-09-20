import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
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
  familyFor,
  importantKinds,
  loadSchema,
  prng,
  SCRIPT_VERSION,
  scriptVersionFor,
  scenarioSchema,
  type Scenario,
  type FamilyId,
  deliverySchema,
  noiseSchema,
  type Delivery,
  type Noise,
} from './scenario.js';
import { FORMAT, type Summary } from './schema.js';
import { auditRun } from './audit.js';

export const profileSchema = z.enum([
  'smoke',
  'load-sweep',
  'controls',
  'new-scenarios',
  'scenario-matrix',
  'interrupt-pilot',
]);
export type Profile = z.infer<typeof profileSchema>;
const trialSchema = conditionSchema.safeExtend({
  id: z.string().regex(/^t\d{3}$/),
  replicate: z.number().int().min(1).max(10),
  reused: z
    .object({
      path: z.string(),
      sha256: z.string(),
      integritySha256: z.string(),
      compatibility: z.string(),
    })
    .optional(),
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
    scenarios: z.array(scenarioSchema).min(1).optional(),
    delivery: deliverySchema.optional(),
    noise: noiseSchema.optional(),
  }),
  baselines: z.array(z.object({ path: z.string(), sha256: z.string() })).optional(),
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
  scenarios: Scenario[] = ['task-cancellation', 'urgency-downgrade', 'delayed-relevance'],
): Trial[] {
  type Cell = Omit<Trial, 'id' | 'replicate' | 'seed'>;
  let cells: Cell[];
  if (profile === 'interrupt-pilot') {
    cells = families.flatMap((family) =>
      (['task-cancellation', 'urgency-downgrade'] as const).flatMap((scenario) => [
        {
          family,
          scenario,
          load: 'high' as const,
          delivery: 'interrupt' as const,
          noise: 'none' as const,
        },
        {
          family,
          scenario,
          load: 'high' as const,
          delivery: 'interrupt' as const,
          noise: 'normal' as const,
        },
        {
          family,
          scenario,
          load: 'high' as const,
          delivery: 'interrupt' as const,
          noise: 'normal' as const,
          updates: 'disabled' as const,
        },
      ]),
    );
  } else if (profile === 'scenario-matrix') {
    cells = families.flatMap((family) =>
      scenarioSchema.options.map((scenario) => ({
        family,
        scenario,
        load: 'high' as const,
        noise: 'normal' as const,
        delivery: 'ambient' as const,
      })),
    );
  } else if (profile === 'new-scenarios') {
    if (
      !scenarios.length ||
      scenarios.includes('updates') ||
      new Set(scenarios).size !== scenarios.length
    )
      throw Error(
        'new-scenarios requires distinct new scenario arms; updates belong to the baseline',
      );
    cells = families.flatMap((family) =>
      scenarios.map((scenario) => ({
        family,
        scenario,
        load: 'high' as const,
        noise: 'normal' as const,
        delivery: 'ambient' as const,
      })),
    );
  } else if (profile === 'smoke')
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
        seed:
          profile === 'scenario-matrix' && cell.scenario === 'updates'
            ? replicate
            : hashCombine(seed, cell.family, replicate),
      });
  }
  return trials;
}

function fixtureHashes() {
  return Object.fromEntries(
    familySchema.options
      .flatMap((f) =>
        loadSchema.options.map((l) => [`${f}/${l}`, fixtureDigest(FAMILIES[f], l)]),
      )
      .concat(
        familySchema.options.flatMap((f) =>
          loadSchema.options.map((l) => [
            `${f}/${l}/delayed-relevance`,
            fixtureDigest(familyFor({ family: f, scenario: 'delayed-relevance' }), l),
          ]),
        ),
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
    scenarios?: Scenario[];
    baselineDir?: string;
    reuseDirs?: string[];
    delivery?: Delivery;
    noise?: Noise;
  },
) {
  const sources = await sourceIdentity();
  const families = options.families ?? [...familySchema.options];
  const seed = options.seed ?? 0,
    repetitions = options.repetitions ?? 3;
  if (
    (options.profile === 'interrupt-pilot' || options.delivery === 'interrupt') &&
    options.modelConfig?.provider !== 'openai-codex'
  )
    throw Error('Interrupt delivery requires native Codex');
  if (options.profile === 'interrupt-pilot' && (options.delivery || options.noise))
    throw Error('interrupt-pilot defines its own delivery and noise conditions');
  if (options.scenarios && options.profile !== 'new-scenarios')
    throw Error('--scenarios is only supported by new-scenarios');
  const baselines = options.baselineDir
    ? await captureBaselines(options.baselineDir)
    : undefined;
  const manifest = manifestSchema.parse({
    version: '4.0',
    id: options.id,
    createdAt: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    scriptVersion:
      options.profile === 'interrupt-pilot' || options.delivery === 'interrupt'
        ? 'interrupt-1.0'
        : ['new-scenarios', 'scenario-matrix'].includes(options.profile)
          ? SCRIPT_VERSION
          : scriptVersionFor({}),
    familyVersions: Object.fromEntries(
      familySchema.options.flatMap((f) => [
        [f, FAMILIES[f].version],
        [
          f + '/delayed-relevance',
          familyFor({ family: f, scenario: 'delayed-relevance' }).version,
        ],
      ]),
    ),
    fixtureHashes: fixtureHashes(),
    sources,
    systemPromptHash: sha256(SYSTEM_PROMPT),
    modelConfig: options.modelConfig ?? DEFAULT_SELECTION,
    budgets: { ...DEFAULT_BUDGETS, ...options.budgets },
    maxAttemptsPerTrial: options.maxAttemptsPerTrial ?? 2,
    design: {
      profile: options.profile,
      seed,
      repetitions,
      families,
      ...(options.delivery ? { delivery: options.delivery } : {}),
      ...(options.noise ? { noise: options.noise } : {}),
      ...(options.profile === 'new-scenarios'
        ? {
            scenarios: options.scenarios ?? [
              'task-cancellation',
              'urgency-downgrade',
              'delayed-relevance',
            ],
          }
        : {}),
    },
    ...(baselines ? { baselines } : {}),
    trials: schedule(options.profile, seed, repetitions, families, options.scenarios).map(
      (t) => ({
        ...t,
        ...(options.delivery ? { delivery: options.delivery } : {}),
        ...(options.noise ? { noise: options.noise } : {}),
      }),
    ),
  });
  if (options.reuseDirs?.length) {
    if (options.profile !== 'scenario-matrix')
      throw Error('Cached trial reuse requires scenario-matrix');
    const saved = (await Promise.all(options.reuseDirs.map(captureBaselines))).flat();
    for (const ref of saved) {
      const summary = JSON.parse(await readFile(ref.path, 'utf8')) as Summary;
      const trial = manifest.trials.find((t) => sameCondition(t, summary.condition));
      if (!trial) throw Error('Saved run has no matching trial: ' + ref.path);
      if (trial.reused) throw Error('Duplicate saved result for a trial: ' + ref.path);
      if (
        !summary.grade.valid ||
        summary.grade.censored ||
        !(await auditRun(path.dirname(ref.path))).eligible
      )
        throw Error('Saved run is not eligible for reuse: ' + ref.path);
      const r = summary.runtime,
        selection = manifest.modelConfig;
      if (
        r['model'] !== selection.model ||
        r['provider'] !== selection.provider ||
        r['thinking'] !== selection.thinking ||
        r['agent'] !== (selection.provider === 'anthropic' ? 'claude-code' : 'codex') ||
        r['fixtureDigest'] !== fixtureDigest(familyFor(trial), trial.load) ||
        r['systemPromptSha256'] !== manifest.systemPromptHash ||
        r['protocolVersion'] !== PROTOCOL_VERSION
      )
        throw Error(
          'Saved run has incompatible model, fixture, prompt, or protocol: ' + ref.path,
        );
      const script = r['scriptVersion'];
      const compatiblePrior =
        script === 'scenario-arms-1.0' &&
        ['task-cancellation', 'delayed-relevance'].includes(trial.scenario ?? '');
      if (script !== scriptVersionFor(trial) && !compatiblePrior)
        throw Error('Saved run has incompatible event timing: ' + ref.path);
      trial.reused = {
        ...ref,
        integritySha256: sha256(
          await readFile(path.join(path.dirname(ref.path), 'integrity.json')),
        ),
        compatibility: compatiblePrior
          ? 'Scenario 1.1 changes downgrade timing only; retained cancellation/delayed evidence is unchanged.'
          : 'Same scenario, fixture, prompt, native agent, model selection, and seed.',
      };
    }
  }
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

/** Saved evidence is referenced and hash-checked, never copied into new trials or regraded. */
export async function captureBaselines(
  dir: string,
): Promise<Array<{ path: string; sha256: string }>> {
  const found: Array<{ path: string; sha256: string }> = [];
  async function walk(root: string, depth: number) {
    const file = path.join(root, 'summary.json');
    if (await exists(file)) {
      const bytes = await readFile(file);
      const summary = JSON.parse(bytes.toString()) as Summary;
      if (summary.format !== FORMAT) throw Error('Unsupported baseline: ' + file);
      found.push({ path: file, sha256: sha256(bytes) });
      return;
    }
    if (depth >= 3) return;
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    ))
      if (entry.isDirectory() && !entry.name.startsWith('.'))
        await walk(path.join(root, entry.name), depth + 1);
  }
  await walk(path.resolve(dir), 0);
  if (!found.length) throw Error('No saved baseline runs in ' + dir);
  return found;
}

export async function readBaselines(manifest: Pick<Manifest, 'baselines'>) {
  return Promise.all(
    (manifest.baselines ?? []).map(async (ref) => {
      const bytes = await readFile(ref.path);
      if (sha256(bytes) !== ref.sha256) throw Error('Saved baseline changed: ' + ref.path);
      const s = JSON.parse(bytes.toString()) as Summary;
      return {
        path: ref.path,
        sha256: ref.sha256,
        runId: s.runId,
        condition: s.condition,
        model: s.runtime['model'],
        scriptVersion: s.runtime['scriptVersion'],
        graderVersion: s.grade.graderVersion,
        valid: s.grade.valid,
        censored: s.grade.censored,
        summary: s.grade.summary,
      };
    }),
  );
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
          : summary.termination.reason === 'harness_error'
            ? { id, state: 'harness_error' }
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
  await readBaselines(manifest);
  for (const trial of manifest.trials) if (trial.reused) await readReused(trial);
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
export async function execute(
  file: string,
  root: string,
  maxNew = Infinity,
  concurrency = 1,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw Error('Concurrency must be 1–4');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  await verifyFrozen(manifest);
  const dir = path.resolve(root, manifest.id),
    runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const lock = await open(path.join(dir, '.batch.lock'), 'wx');
  let launched = 0;
  let haltedBy: string | null = null;
  let next = 0;
  let comparisons: Promise<unknown> = Promise.resolve();
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
    const worker = async () => {
      while (next < manifest.trials.length) {
        if (haltedBy || launched >= maxNew) break;
        const trial = manifest.trials[next++]!;
        if (trial.reused) continue;
        const prior = await attempts(runsDir, trial);
        const last = prior.at(-1);
        if (last?.state === 'completed') continue;
        if (last?.state === 'harness_error' || last?.state === 'incomplete') {
          haltedBy = `${last.id}: ${last.state}`;
          break;
        }
        if (prior.length >= manifest.maxAttemptsPerTrial) continue;
        if (haltedBy || launched >= maxNew) break;
        const runId = prior.length ? `${trial.id}.r${prior.length + 1}` : trial.id;
        launched++;
        console.log(
          `\n=== ${runId} ${trial.family}/${trial.load}/${trial.noise}/${trial.delivery} rep ${trial.replicate}`,
        );
        try {
          const result = await run({
            runId,
            resultsDir: runsDir,
            condition: {
              family: trial.family,
              load: trial.load,
              noise: trial.noise,
              delivery: trial.delivery,
              seed: trial.seed,
              ...(trial.scenario ? { scenario: trial.scenario } : {}),
              ...(trial.updates ? { updates: trial.updates } : {}),
            },
            budgets: manifest.budgets,
            keepWorkspace: false,
            expectedSources: manifest.sources,
            manifestHash: sha256(JSON.stringify(manifest)),
            modelConfig: manifest.modelConfig,
          });
          if (['provider_error', 'harness_error'].includes(result.termination.reason))
            haltedBy = `${runId}: ${result.termination.reason}: ${result.termination.detail}`;
        } catch (e) {
          console.error(`${runId} attempt error: ${String(e)}`);
          haltedBy = `${runId}: ${String(e)}`;
        }
        comparisons = comparisons.then(() => compare(file, root));
        await comparisons;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
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
    if (trial.reused) {
      trials.push({ trial, attempts: [], summary: await readReused(trial) });
      continue;
    }
    const all = (await exists(runsDir)) ? await attempts(runsDir, trial) : [];
    const final = [...all].reverse().find((a) => a.state === 'completed');
    trials.push({
      trial,
      attempts: all.map((a) => ({ id: a.id, state: a.state })),
      summary: final?.state === 'completed' ? final.summary : null,
    });
  }
  const result = {
    ...summarize(manifest, trials),
    reusedTrials: manifest.trials.filter((t) => t.reused).length,
    baselines: await readBaselines(manifest),
  };
  if (await exists(dir)) {
    await writeFile(
      path.join(dir, 'comparison.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    await writeFile(path.join(dir, 'comparison.md'), renderComparison(result));
  }
  return result;
}

function sameCondition(a: Trial, b: Summary['condition']) {
  return (
    a.family === b.family &&
    (a.scenario ?? 'updates') === (b.scenario ?? 'updates') &&
    a.load === b.load &&
    a.noise === b.noise &&
    a.delivery === b.delivery &&
    (a.updates ?? 'enabled') === (b.updates ?? 'enabled') &&
    a.seed === b.seed
  );
}

async function readReused(trial: Trial): Promise<Summary> {
  const ref = trial.reused!;
  const bytes = await readFile(ref.path);
  if (
    sha256(bytes) !== ref.sha256 ||
    sha256(await readFile(path.join(path.dirname(ref.path), 'integrity.json'))) !==
      ref.integritySha256
  )
    throw Error('Saved evidence changed: ' + ref.path);
  const summary = JSON.parse(bytes.toString()) as Summary;
  if (
    !sameCondition(trial, summary.condition) ||
    !(await auditRun(path.dirname(ref.path))).eligible
  )
    throw Error('Saved evidence no longer matches its trial: ' + ref.path);
  return summary;
}
export type Comparison = ReturnType<typeof summarize> & {
  baselines?: Awaited<ReturnType<typeof readBaselines>>;
};

export function summarize(manifest: Manifest, trials: TrialRecord[]) {
  const key = (t: Trial) =>
    `${t.family}/${t.load}/${t.noise}/${t.delivery}${t.scenario && t.scenario !== 'updates' ? '/' + t.scenario : ''}${t.updates === 'disabled' ? '/noise-only-control' : ''}`;
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
          s.grade.events.filter((e) => e.kind === kind && e.fired && e.adapted !== null),
        );
        return [
          kind,
          {
            fired: metrics.length,
            behaviorUnassessable: metrics.filter((e) => e.adapted === null).length,
            timingEligible: metrics.filter((e) => e.timing?.eligible).length,
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
        ...(members[0]?.trial.updates === 'disabled'
          ? {
              noiseControl: fraction(
                uncensored.filter((s) => s.grade.outcome['noiseControlPassed'] === true)
                  .length,
                uncensored.filter(
                  (s) => typeof s.grade.outcome['noiseControlPassed'] === 'boolean',
                ).length,
              ),
            }
          : {}),
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
          valid.filter(
            (s) =>
              s.grade.urgent['hotfixCorrect'] !== null &&
              s.grade.urgent['hotfixCorrect'] !== undefined,
          ).length,
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
  if (r.baselines?.length) {
    lines.push(
      '## Saved baseline (historical; excluded from new-trial totals)',
      '',
      '| Run | Model | Script | Grader | Valid | Saved summary |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const b of r.baselines)
      lines.push(
        `| ${b.runId} | ${b.model} | ${b.scriptVersion} | ${b.graderVersion} | ${b.valid} | [artifact](${b.path}) |`,
      );
    lines.push('');
  }
  return lines.join('\n');
}
